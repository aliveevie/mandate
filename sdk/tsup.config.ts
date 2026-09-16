import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/privy.ts", "src/prf.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  external: ["viem", "@privy-io/node", "@privy-io/node/viem", "@category-labs/mera", "@category-labs/mera/viem"],
});
