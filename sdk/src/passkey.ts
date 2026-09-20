import { getContract, type Address, type Hex } from "viem";
import { PasskeyAccountAbi, PasskeyAccountBytecode, SignerAccountAbi, SignerAccountBytecode } from "./abi/generated.js";
import { resolveWallet, waitTx } from "./signer.js";
import type {
  MandateAddresses,
  MandatePublicClient,
  PasskeyPrincipal,
  PasskeySigner,
  Principal,
  PrincipalStorage,
  Signer,
  SignerPrincipal,
  StoredPrincipal,
  TypedDataInput,
} from "./types.js";
import {
  base64UrlDecode,
  base64UrlEncode,
  clientDataIndexes,
  derToRS,
  encodeWebAuthnAuth,
  normalizeS,
  randomBytes,
  toBytes32,
  uint8ToHex,
  webauthnMessage,
} from "./webauthn.js";

const STORAGE_KEY = "ibxlab.mandate.principal";

// ---------------------------------------------------------------------------------------------
// WebAuthn (browser) passkey
// ---------------------------------------------------------------------------------------------

export interface WebAuthnCreateOptions {
  /** Relying party id. Must equal the page hostname (no scheme, no port). */
  rpId: string;
  rpName?: string;
  userName?: string;
  userDisplayName?: string;
}

function hasWebAuthn(): boolean {
  return typeof navigator !== "undefined" && !!navigator.credentials && typeof PublicKeyCredential !== "undefined";
}

/** Extract uncompressed P-256 (x, y) from a SubjectPublicKeyInfo DER blob. */
function spkiToXY(spki: ArrayBuffer): { x: Hex; y: Hex } {
  const bytes = new Uint8Array(spki);
  const point = bytes.slice(bytes.length - 65);
  if (point[0] !== 0x04) throw new Error("Unexpected public key encoding (expected uncompressed P-256 point)");
  return { x: uint8ToHex(point.slice(1, 33)), y: uint8ToHex(point.slice(33, 65)) };
}

export class WebAuthnPasskey implements PasskeySigner {
  readonly kind = "webauthn" as const;
  constructor(
    readonly credentialId: string,
    readonly publicKey: { x: Hex; y: Hex },
    readonly rpId: string,
  ) {}

  static async create(opts: WebAuthnCreateOptions): Promise<WebAuthnPasskey> {
    if (!hasWebAuthn()) throw new Error("WebAuthn is not available in this environment. Use createSoftwarePasskey() on servers.");
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { id: opts.rpId, name: opts.rpName ?? "Mandate" },
        user: {
          id: randomBytes(16),
          name: opts.userName ?? "mandate-principal",
          displayName: opts.userDisplayName ?? "Mandate principal",
        },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none",
        // Ask for the PRF extension at creation so synced platform passkeys can evaluate PRF later (Mera PRF).
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error("Passkey creation was cancelled");
    const resp = cred.response as AuthenticatorAttestationResponse;
    if (typeof resp.getPublicKey !== "function") throw new Error("Browser does not expose getPublicKey(); cannot derive P-256 key");
    const spki = resp.getPublicKey();
    if (!spki) throw new Error("Authenticator returned no public key");
    return new WebAuthnPasskey(base64UrlEncode(new Uint8Array(cred.rawId)), spkiToXY(spki), opts.rpId);
  }

  async signChallenge(challenge: Hex): Promise<Hex> {
    if (!hasWebAuthn()) throw new Error("WebAuthn is not available in this environment");
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: hexBytes(challenge),
        rpId: this.rpId,
        allowCredentials: [{ id: base64UrlDecode(this.credentialId), type: "public-key" }],
        userVerification: "required",
      },
    })) as PublicKeyCredential | null;
    if (!assertion) throw new Error("Passkey assertion was cancelled");
    const resp = assertion.response as AuthenticatorAssertionResponse;
    const authenticatorData = new Uint8Array(resp.authenticatorData);
    const clientDataJSON = new TextDecoder().decode(resp.clientDataJSON);
    const { r, s } = derToRS(new Uint8Array(resp.signature));
    const idx = clientDataIndexes(clientDataJSON, challenge);
    return encodeWebAuthnAuth({
      authenticatorData: uint8ToHex(authenticatorData),
      clientDataJSON,
      ...idx,
      r: toBytes32(r),
      s: toBytes32(normalizeS(s)),
    });
  }
}

function hexBytes(hex: Hex): Uint8Array<ArrayBuffer> {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Software passkey (WebCrypto P-256). For servers, CI and quickstarts. Produces the same
// WebAuthn-shaped assertion, so the on-chain path is identical to a real authenticator.
// ---------------------------------------------------------------------------------------------

export class SoftwarePasskey implements PasskeySigner {
  readonly kind = "software" as const;
  private constructor(
    readonly publicKey: { x: Hex; y: Hex },
    private readonly privateKey: CryptoKey,
    readonly privateJwk: JsonWebKey,
    readonly rpId: string,
  ) {}

  static async create(rpId = "mandate.local"): Promise<SoftwarePasskey> {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    return SoftwarePasskey.fromJwk(jwk, rpId);
  }

  static async fromJwk(jwk: JsonWebKey, rpId = "mandate.local"): Promise<SoftwarePasskey> {
    if (!jwk.x || !jwk.y || !jwk.d) throw new Error("JWK must be a P-256 private key");
    const priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const publicKey = { x: uint8ToHex(base64UrlDecode(jwk.x)), y: uint8ToHex(base64UrlDecode(jwk.y)) };
    return new SoftwarePasskey(publicKey, priv, jwk, rpId);
  }

  async signChallenge(challenge: Hex): Promise<Hex> {
    const clientDataJSON = JSON.stringify({
      type: "webauthn.get",
      challenge: base64UrlEncode(hexBytes(challenge)),
      origin: `https://${this.rpId}`,
      crossOrigin: false,
    });
    const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.rpId)));
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(rpIdHash, 0);
    authenticatorData[32] = 0x05; // UP | UV
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.privateKey, webauthnMessage(authenticatorData, clientDataJSON)),
    );
    const r = BigInt(uint8ToHex(sig.slice(0, 32)));
    const s = normalizeS(BigInt(uint8ToHex(sig.slice(32, 64))));
    const idx = clientDataIndexes(clientDataJSON, challenge);
    return encodeWebAuthnAuth({
      authenticatorData: uint8ToHex(authenticatorData),
      clientDataJSON,
      ...idx,
      r: toBytes32(r),
      s: toBytes32(s),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Principal = passkey + deployed PasskeyAccount
// ---------------------------------------------------------------------------------------------

function memoryStorage(): PrincipalStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

function defaultStorage(): PrincipalStorage {
  if (typeof localStorage !== "undefined") {
    return {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
      remove: (k) => localStorage.removeItem(k),
    };
  }
  return memoryStorage();
}

/** A SignerAccount principal. `signTypedData` is whatever key controls the account: a wallet, a viem account, or a delegated session signer. */
export class SignerPrincipalImpl implements SignerPrincipal {
  readonly kind = "signer" as const;
  constructor(
    readonly address: Address,
    readonly owner: Address,
    private readonly signer: (td: TypedDataInput) => Promise<Hex>,
  ) {}
  signTypedData(td: TypedDataInput) {
    return this.signer(td);
  }
  toJSON(): StoredPrincipal {
    return { kind: "signer", address: this.address, owner: this.owner };
  }
}

class PrincipalImpl implements PasskeyPrincipal {
  constructor(
    private readonly signer: PasskeySigner & { rpId?: string; privateJwk?: JsonWebKey },
    readonly address: Address,
  ) {}
  get kind() {
    return this.signer.kind;
  }
  get publicKey() {
    return this.signer.publicKey;
  }
  get credentialId() {
    return this.signer.credentialId;
  }
  signChallenge(challenge: Hex) {
    return this.signer.signChallenge(challenge);
  }
  toJSON(): StoredPrincipal {
    return {
      kind: this.signer.kind,
      address: this.address,
      publicKey: this.signer.publicKey,
      credentialId: this.signer.credentialId,
      rpId: this.signer.rpId,
      privateJwk: this.signer.kind === "software" ? this.signer.privateJwk : undefined,
    };
  }
}

export interface PasskeyModuleDeps {
  publicClient: MandatePublicClient;
  addresses: MandateAddresses;
  signer?: Signer;
  rpcUrl?: string;
  storage?: PrincipalStorage;
}

export interface CreatePrincipalOptions extends WebAuthnCreateOptions {
  /** Pays gas for the PasskeyAccount deployment. Defaults to the client signer. */
  signer?: Signer;
  /** Use a WebCrypto software key instead of a browser passkey (servers, CI, quickstart). */
  software?: boolean;
  /** Persist under this key. Defaults to a single shared slot. */
  storageKey?: string;
}

export function createPasskeyModule(deps: PasskeyModuleDeps) {
  const storage = deps.storage ?? defaultStorage();

  async function deployAccount(pk: PasskeySigner, signer?: Signer): Promise<Address> {
    const wallet = resolveWallet(signer ?? deps.signer, deps.publicClient, deps.rpcUrl);
    const hash = await wallet.deployContract({
      abi: PasskeyAccountAbi,
      bytecode: PasskeyAccountBytecode as Hex,
      args: [pk.publicKey.x, pk.publicKey.y, deps.addresses.registry, deps.addresses.executor],
      chain: wallet.chain,
      account: wallet.account,
    });
    const receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("PasskeyAccount deployment returned no address");
    return receipt.contractAddress;
  }

  async function persist(p: Principal, key = STORAGE_KEY) {
    await storage.set(key, JSON.stringify(p.toJSON()));
  }

  /** Deploy a SignerAccount owned by `owner` (an EOA, embedded wallet or ERC-1271 contract). */
  async function deploySignerAccount(owner: Address, signer?: Signer): Promise<Address> {
    const wallet = resolveWallet(signer ?? deps.signer, deps.publicClient, deps.rpcUrl);
    const hash = await wallet.deployContract({
      abi: SignerAccountAbi,
      bytecode: SignerAccountBytecode as Hex,
      args: [owner, deps.addresses.registry, deps.addresses.executor],
      chain: wallet.chain,
      account: wallet.account,
    });
    const receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("SignerAccount deployment returned no address");
    return receipt.contractAddress;
  }

  const passkeyApi = {
    /**
     * Create only the key (no transaction). Use when a relayer deploys the account: send `publicKey`
     * to your server, then `attach(key, address)` and `save(principal)`.
     */
    async createKey(opts: WebAuthnCreateOptions & { software?: boolean }): Promise<PasskeySigner & { rpId: string }> {
      return opts.software ? SoftwarePasskey.create(opts.rpId) : WebAuthnPasskey.create(opts);
    },

    /** Persist a principal for `load()`. */
    async save(principal: Principal, opts: { storageKey?: string } = {}): Promise<void> {
      await persist(principal, opts.storageKey);
    },

    /**
     * Create a passkey (Face ID / Touch ID in the browser, WebCrypto with `software: true`),
     * deploy its PasskeyAccount and persist the principal for `load()`.
     */
    async create(opts: CreatePrincipalOptions): Promise<PasskeyPrincipal> {
      const pk = opts.software ? await SoftwarePasskey.create(opts.rpId) : await WebAuthnPasskey.create(opts);
      const address = await deployAccount(pk, opts.signer);
      const principal = new PrincipalImpl(pk, address);
      await persist(principal, opts.storageKey);
      return principal;
    },

    /** Load a previously created principal from storage. Returns null if none is stored. */
    async load(opts: { storageKey?: string } = {}): Promise<PasskeyPrincipal | null> {
      const raw = await storage.get(opts.storageKey ?? STORAGE_KEY);
      if (!raw) return null;
      const stored = JSON.parse(raw) as StoredPrincipal;
      if (stored.kind === "signer") return null; // needs its external signer; the app re-attaches it
      return passkeyApi.fromJSON(stored);
    },

    /** Rehydrate a principal from its serialised form. */
    async fromJSON(stored: StoredPrincipal): Promise<PasskeyPrincipal> {
      if (stored.kind === "signer") {
        throw new Error("Signer principals are restored with attachSigner(address, owner, signTypedData); the signing key lives outside the SDK");
      }
      if (stored.kind === "software") {
        if (!stored.privateJwk) throw new Error("Stored software principal has no key material");
        return new PrincipalImpl(await SoftwarePasskey.fromJwk(stored.privateJwk, stored.rpId), stored.address);
      }
      if (!stored.credentialId || !stored.rpId || !stored.publicKey) throw new Error("Stored WebAuthn principal is missing credentialId, rpId or publicKey");
      return new PrincipalImpl(new WebAuthnPasskey(stored.credentialId, stored.publicKey, stored.rpId), stored.address);
    },

    /** Attach an already-deployed PasskeyAccount to a signer (for example after a page reload on another device). */
    async attach(pk: PasskeySigner & { rpId?: string }, address: Address): Promise<PasskeyPrincipal> {
      const account = getContract({ address, abi: PasskeyAccountAbi, client: deps.publicClient });
      const [x, y] = await Promise.all([account.read.pubKeyX(), account.read.pubKeyY()]);
      if (x.toLowerCase() !== pk.publicKey.x.toLowerCase() || y.toLowerCase() !== pk.publicKey.y.toLowerCase()) {
        throw new Error("PasskeyAccount at that address is owned by a different key");
      }
      return new PrincipalImpl(pk, address);
    },

    /** Deploy a PasskeyAccount for an existing passkey signer. */
    deployAccount,

    /** Deploy a SignerAccount for a secp256k1 owner (embedded wallet, EOA, ERC-1271 contract). */
    deploySignerAccount,

    /**
     * Bind a deployed SignerAccount to whatever can sign EIP-712 for its owner: a viem account, a wallet
     * client, or a server-held session signer. Verifies the account's owner on-chain.
     */
    async attachSigner(input: { address: Address; owner: Address; signTypedData: (td: TypedDataInput) => Promise<Hex> }): Promise<SignerPrincipal> {
      const account = getContract({ address: input.address, abi: SignerAccountAbi, client: deps.publicClient });
      const onchainOwner = await account.read.owner();
      if (onchainOwner.toLowerCase() !== input.owner.toLowerCase()) {
        throw new Error("SignerAccount at that address has a different owner");
      }
      return new SignerPrincipalImpl(input.address, input.owner, input.signTypedData);
    },

    /** Forget the stored principal. */
    async clear(opts: { storageKey?: string } = {}) {
      await storage.remove(opts.storageKey ?? STORAGE_KEY);
    },
  };
  return passkeyApi;
}

export type PasskeyModule = ReturnType<typeof createPasskeyModule>;
