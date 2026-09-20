// Content-addressed store for encrypted policy vaults. Ciphertext in, ciphertext out: the server validates the
// vault's shape and that the key equals the vault's canonical hash, and can neither read nor alter it. Persisted to a
// JSON file so a restart does not lose the vaults the cross-device check depends on (any blob store would do).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parsePolicyVault, policyHashOf, type PolicyVault } from "@ibxlab/mandate";

const LIMIT = 5_000;
const MAX_VAULT_BYTES = 8 * 1024;

export class BlobStore {
  private map = new Map<string, PolicyVault>();
  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        for (const [k, v] of Object.entries(raw)) {
          try {
            const vault = parsePolicyVault(v);
            if (policyHashOf(vault) === k) this.map.set(k, vault);
          } catch { /* skip corrupt entries */ }
        }
      } catch { /* start empty */ }
    }
  }

  get size() {
    return this.map.size;
  }

  get(hash: string): PolicyVault | undefined {
    return this.map.get(hash.toLowerCase());
  }

  /** Stores a vault under its own policyHash. Throws `{status}` errors for bad input. */
  put(hash: string, body: unknown): PolicyVault {
    const key = hash.toLowerCase();
    if (JSON.stringify(body ?? "").length > MAX_VAULT_BYTES) throw Object.assign(new Error(`Vault larger than ${MAX_VAULT_BYTES} bytes`), { status: 413 });
    let vault: PolicyVault;
    try {
      vault = parsePolicyVault(body);
    } catch (e) {
      throw Object.assign(new Error((e as Error).message), { status: 400, code: "InvalidVault" });
    }
    if (policyHashOf(vault) !== key) throw Object.assign(new Error("policyHash does not match the vault's canonical encoding"), { status: 400, code: "HashMismatch" });
    if (!this.map.has(key) && this.map.size >= LIMIT) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, vault);
    this.flush();
    return vault;
  }

  private flush() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
      renameSync(tmp, this.path);
    } catch (e) {
      console.error("blob store flush failed:", (e as Error).message);
    }
  }
}
