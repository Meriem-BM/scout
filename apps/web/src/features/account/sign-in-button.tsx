"use client";

import { useScoutAuth } from "./auth-context";

export function SignInButton({
  destination,
  className,
  children,
}: {
  destination: string;
  className?: string;
  children: React.ReactNode;
}) {
  const auth = useScoutAuth();

  return (
    <button
      type="button"
      className={className}
      disabled={!auth.configured || !auth.ready || auth.restoring}
      title={
        auth.configured
          ? undefined
          : "Privy sign-in is not configured for this deployment."
      }
      onClick={() => auth.login(destination)}
    >
      {children}
    </button>
  );
}
