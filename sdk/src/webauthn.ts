import { bytesToHex, concatHex, encodeAbiParameters, hexToBytes, sha256, type Hex } from "viem";

/** secp256r1 group order. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = P256_N / 2n;

export interface WebAuthnAuth {
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: Hex;
  s: Hex;
}

const WEBAUTHN_AUTH_ABI = [
  {
    type: "tuple",
    components: [
      { name: "authenticatorData", type: "bytes" },
      { name: "clientDataJSON", type: "string" },
      { name: "challengeIndex", type: "uint256" },
      { name: "typeIndex", type: "uint256" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
  },
] as const;

/** ABI-encode the assertion exactly as `PasskeyAccount.isValidSignature` expects. */
export function encodeWebAuthnAuth(auth: WebAuthnAuth): Hex {
  return encodeAbiParameters(WEBAUTHN_AUTH_ABI, [auth]);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Locate the `"challenge":"…"` and `"type":"webauthn.get"` fields the contract checks. */
export function clientDataIndexes(clientDataJSON: string, challenge: Hex): { challengeIndex: bigint; typeIndex: bigint } {
  const expectedChallenge = `"challenge":"${base64UrlEncode(hexToBytes(challenge))}"`;
  const challengeIndex = clientDataJSON.indexOf(expectedChallenge);
  const typeIndex = clientDataJSON.indexOf('"type":"webauthn.get"');
  if (challengeIndex < 0) throw new Error("WebAuthn clientDataJSON does not contain the expected challenge");
  if (typeIndex < 0) throw new Error("WebAuthn clientDataJSON type is not webauthn.get");
  return { challengeIndex: BigInt(challengeIndex), typeIndex: BigInt(typeIndex) };
}

/** Enforce low-s. The contract rejects malleable signatures. */
export function normalizeS(s: bigint): bigint {
  return s > HALF_N ? P256_N - s : s;
}

/** Parse an ASN.1 DER ECDSA signature (as returned by WebAuthn) into r and s. */
export function derToRS(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw new Error("Invalid DER signature");
  let offset = 2;
  if ((der[1]! & 0x80) !== 0) offset += der[1]! & 0x7f;
  const readInt = (): bigint => {
    if (der[offset] !== 0x02) throw new Error("Invalid DER integer");
    const len = der[offset + 1]!;
    const start = offset + 2;
    let v = 0n;
    for (let i = start; i < start + len; i++) v = (v << 8n) | BigInt(der[i]!);
    offset = start + len;
    return v;
  };
  const r = readInt();
  const s = readInt();
  return { r, s };
}

export function toBytes32(v: bigint): Hex {
  return `0x${v.toString(16).padStart(64, "0")}`;
}

/** Message the authenticator actually signs: sha256(authenticatorData ‖ sha256(clientDataJSON)). */
export function webauthnMessage(authenticatorData: Uint8Array, clientDataJSON: string): Uint8Array<ArrayBuffer> {
  const clientDataHash = hexToBytes(sha256(new TextEncoder().encode(clientDataJSON)));
  const msg = new Uint8Array(authenticatorData.length + 32);
  msg.set(authenticatorData);
  msg.set(clientDataHash, authenticatorData.length);
  return msg;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function uint8ToHex(bytes: Uint8Array): Hex {
  return bytesToHex(bytes);
}

export { concatHex };
