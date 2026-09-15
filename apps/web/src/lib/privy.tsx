/**
 * Privy in the reference app: sign in without a passkey device, delegate a scoped session signer to the
 * server's key quorum, and let the server grant / revoke on your behalf through a SignerAccount.
 * Rendered only when the server reports Privy as configured.
 */
import { PrivyProvider, useIdentityToken, usePrivy, useSigners, useWallets } from "@privy-io/react-auth";
import type { ReactNode } from "react";
import { monadTestnet } from "viem/chains";
import type { PublicConfig } from "./api";

export function MaybePrivyProvider({ cfg, children }: { cfg: PublicConfig; children: ReactNode }) {
  if (!cfg.privy.enabled || !cfg.privy.appId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={cfg.privy.appId}
      config={{
        appearance: { theme: "dark", accentColor: "#8b5cf6", showWalletLoginFirst: false },
        loginMethods: ["email", "google", "passkey", "wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: monadTestnet,
        supportedChains: [monadTestnet],
      }}
    >
      {children}
    </PrivyProvider>
  );
}

/** Everything a screen needs from Privy, or `null` when Privy is not configured. */
export function usePrivySession(enabled: boolean) {
  if (!enabled) return null;
  // Hooks are called unconditionally within this branch for the lifetime of the app (enabled never changes).
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { ready, authenticated, user, login, logout } = usePrivy();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { wallets } = useWallets();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { addSigners } = useSigners();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { identityToken } = useIdentityToken();
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  return { ready, authenticated, user, login, logout, embedded, addSigners, identityToken };
}
