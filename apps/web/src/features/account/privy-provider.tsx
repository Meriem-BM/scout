"use client";

import {
  getIdentityToken,
  PrivyProvider,
  useLogin,
  usePrivy,
} from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { mainnet } from "viem/chains";
import { z } from "zod";

import { clearPrivateDrafts } from "../watches/review-draft";

import { AuthContext, type ScoutAccount } from "./auth-context";
import {
  authenticatedFetch,
  installAuthTransport,
  resetAuthTransport,
} from "./auth-transport";
import { rememberAuthDestination, takeAuthDestination } from "./return-to";

const Account = z.object({
  userId: z.uuid(),
  email: z.email().nullable(),
});

function SessionBridge({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const accessTokenGetter = useRef(getAccessToken);
  const subject = authenticated ? (user?.id ?? null) : null;
  const activeSubject = useRef(subject);
  const [result, setResult] = useState<{
    subject: string | null;
    account: ScoutAccount | null;
    error: string | null;
    restoring: boolean;
  }>({ subject: null, account: null, error: null, restoring: false });
  const [revision, setRevision] = useState(0);
  const blocked = useRef(false);
  const restoreAttempt = useRef(0);
  const mounted = useRef(true);
  const previous = useRef<string | null>(null);

  useEffect(() => {
    activeSubject.current = subject;
  }, [subject]);
  useEffect(() => {
    accessTokenGetter.current = getAccessToken;
  }, [getAccessToken]);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const restore = useCallback(async () => {
    if (!ready || !subject || blocked.current) {
      return;
    }

    const restoringSubject = subject;
    const attempt = ++restoreAttempt.current;

    try {
      const identityToken = await getIdentityToken();

      if (
        attempt !== restoreAttempt.current ||
        !mounted.current ||
        activeSubject.current !== restoringSubject ||
        blocked.current
      ) {
        return;
      }

      setResult({ subject, account: null, error: null, restoring: true });

      const response = await authenticatedFetch("/api/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityToken: identityToken ?? undefined }),
      });
      const value: unknown = await response.json();

      if (!response.ok) {
        throw new Error(
          z.object({ error: z.string() }).safeParse(value).data?.error ??
            "Scout could not restore your account.",
        );
      }

      const account = Account.parse(value);

      if (
        attempt === restoreAttempt.current &&
        mounted.current &&
        activeSubject.current === restoringSubject &&
        !blocked.current
      ) {
        setResult({
          subject: restoringSubject,
          account,
          error: null,
          restoring: false,
        });

        const destination = takeAuthDestination();

        if (destination) {
          router.replace(destination);
        }
      }
    } catch (error) {
      if (
        attempt === restoreAttempt.current &&
        mounted.current &&
        activeSubject.current === restoringSubject &&
        !(error instanceof DOMException && error.name === "AbortError")
      ) {
        setResult({
          subject: restoringSubject,
          account: null,
          error:
            error instanceof Error
              ? error.message
              : "Sign-in could not be completed.",
          restoring: false,
        });
      }
    }
  }, [ready, subject, router]);

  useEffect(() => {
    mounted.current = true;
    blocked.current = false;

    let canceled = false;

    if (previous.current && previous.current !== subject) {
      clearPrivateDrafts();
    }

    previous.current = subject;

    const cleanup = installAuthTransport(
      ready && subject ? () => accessTokenGetter.current() : async () => null,
      () => {
        blocked.current = true;
        clearPrivateDrafts();
        setRevision((n) => n + 1);
        setResult({
          subject,
          account: null,
          error:
            "Your session expired. Sign in again; your watch draft is saved.",
          restoring: false,
        });
      },
    );

    // Synchronize an external Privy session with the verified server account.
    // Deferring the request keeps the effect focused on external synchronization.
    if (ready && subject) {
      queueMicrotask(() => {
        if (!canceled) {
          void restore();
        }
      });
    }

    return () => {
      canceled = true;
      cleanup();
    };
  }, [ready, subject, restore]);

  const { login: openLogin } = useLogin({
    onComplete: () => {
      blocked.current = false;
      void restore();
    },
    onError: () =>
      setResult((current) => ({
        ...current,
        error:
          "Sign-in was canceled or could not finish. Your draft is saved; try again when you're ready.",
        restoring: false,
      })),
  });

  const signOut = async () => {
    restoreAttempt.current++;
    blocked.current = true;
    clearPrivateDrafts();
    setRevision((n) => n + 1);
    setResult({ subject, account: null, error: null, restoring: false });

    try {
      const token = await getAccessToken();

      resetAuthTransport();

      if (token) {
        const response = await fetch("/api/auth/session", {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
          cache: "no-store",
        });

        if (!response.ok && response.status !== 401) {
          throw new Error(
            "Sign out could not reach Scout. Private data is cleared; retry to revoke this session.",
          );
        }
      }

      await logout();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Sign out could not finish. Please retry.";

      setResult({ subject, account: null, error: message, restoring: false });

      throw new Error(message);
    }
  };

  const account =
    ready && subject && result.subject === subject ? result.account : null;

  return (
    <AuthContext
      value={{
        configured: true,
        ready,
        hasSession: authenticated,
        restoring:
          !ready ||
          (!!subject && (result.subject !== subject || result.restoring)),
        account,
        cacheKey: `${subject ?? "anonymous"}:${account?.userId ?? "pending"}:${revision}`,
        error: result.subject === subject ? result.error : null,
        login: (destination) => {
          blocked.current = false;

          if (destination) {
            rememberAuthDestination(destination);
          }

          openLogin();
        },
        logout: signOut,
        restore,
      }}
    >
      {children}
    </AuthContext>
  );
}

export default function ScoutPrivyProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      clientId={process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID || undefined}
      config={{
        appearance: {
          theme: "#1C1B20",
          accentColor: "#6F4CFF",
          logo: "/brands/scout.svg",
          showWalletLoginFirst: false,
          walletChainType: "ethereum-only",
        },
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "off" },
        },
        defaultChain: mainnet,
        supportedChains: [mainnet],
      }}
    >
      <SessionBridge>{children}</SessionBridge>
    </PrivyProvider>
  );
}
