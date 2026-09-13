"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors/injected";

import { useScoutAuth } from "../account/auth-context";

import { shouldRetryRequest } from "./api";
import { TimezoneContext } from "./formatting";
import { useWorkspace } from "./use-workspace";

const PrivyAuth = dynamic(() => import("../account/privy-provider"));
const walletConfig = createConfig({
  chains: [mainnet],
  connectors: [injected()],
  transports: { [mainnet.id]: http() },
  ssr: true,
});

function WorkspaceTimezone({ children }: { children: React.ReactNode }) {
  const { state } = useWorkspace(true);

  return (
    <TimezoneContext value={state.preferences.timezone}>
      {children}
    </TimezoneContext>
  );
}

function AccountWorkspace({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5000,
            retry: shouldRetryRequest,
            refetchIntervalInBackground: false,
          },
          mutations: { retry: false },
        },
      }),
  );

  useEffect(
    () => () => {
      void queryClient.cancelQueries();
      queryClient.clear();
    },
    [queryClient],
  );

  return (
    <WagmiProvider config={walletConfig}>
      <QueryClientProvider client={queryClient}>
        <WorkspaceTimezone>{children}</WorkspaceTimezone>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function AuthenticatedWorkspace({ children }: { children: React.ReactNode }) {
  const auth = useScoutAuth();

  return <AccountWorkspace key={auth.cacheKey}>{children}</AccountWorkspace>;
}

export function Providers({
  children,
  authConfigured,
}: {
  children: React.ReactNode;
  authConfigured: boolean;
}) {
  const workspace = <AuthenticatedWorkspace>{children}</AuthenticatedWorkspace>;

  return authConfigured ? <PrivyAuth>{workspace}</PrivyAuth> : workspace;
}
