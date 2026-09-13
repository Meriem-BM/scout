"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";

import { api, Ok } from "../workspace/api";
import { buttonClassName } from "../workspace/primitives";
import { Busy, ErrorNotice } from "../workspace/ui";
import { useWorkspace } from "../workspace/use-workspace";

import { SignInButton } from "./sign-in-button";

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);

  return () => window.removeEventListener("hashchange", listener);
};

export function EmailLink({ manage = false }: { manage?: boolean }) {
  const { signedIn, refresh } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useSyncExternalStore(
    subscribe,
    () => {
      const value = window.location.hash.slice(1);

      try {
        return (
          value ||
          (!manage
            ? (sessionStorage.getItem("scout.email-verification") ?? "")
            : "")
        );
      } catch {
        return value;
      }
    },
    () => "",
  );

  useEffect(() => {
    if (!token || manage) {
      return;
    }

    try {
      sessionStorage.setItem("scout.email-verification", token);
    } catch {
      // The URL fragment still preserves the token if session storage is unavailable.
    }
  }, [token, manage]);

  return (
    <section className="panel max-w-lg mx-auto">
      <h1>{manage ? "Email alert preferences" : "Verify alert email"}</h1>
      <p className="text-neutral-400 mt-4">
        {done
          ? manage
            ? "Alerts to this email destination are disabled. Watch monitoring and historical evidence are preserved."
            : "This email is verified and enabled as an alert destination."
          : manage
            ? "This link can only disable Scout alerts to the destination that received it."
            : "Confirm this destination for Scout alerts. This is separate from account sign-in."}
      </p>
      <ErrorNotice message={error} />
      {!done &&
        (!signedIn && !manage ? (
          <SignInButton
            destination="/email/verify"
            className={buttonClassName("primary", "mt-5")}
          >
            Sign in to verify this destination
          </SignInButton>
        ) : (
          <button
            className={buttonClassName("primary", "mt-5")}
            disabled={busy || !token}
            onClick={async () => {
              setBusy(true);
              setError(null);

              try {
                if (manage) {
                  const [id, signature] = token.split(".");

                  await api("/api/email/manage", Ok, {
                    method: "POST",
                    body: { id, token: signature },
                  });
                } else {
                  await api("/api/email/verify", Ok, {
                    method: "POST",
                    body: { token },
                  });

                  try {
                    sessionStorage.removeItem("scout.email-verification");
                  } catch {
                    /* Optional storage. */
                  }

                  await refresh();
                }

                setDone(true);
                window.history.replaceState(
                  window.history.state,
                  "",
                  window.location.pathname,
                );
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "Could not complete this request.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <Busy />
            ) : manage ? (
              "Disable email alerts"
            ) : (
              "Verify alert destination"
            )}
          </button>
        ))}
      {!token && !done && (
        <p className="card-notice">
          This link has no verification token. Open the complete link from your
          email.
        </p>
      )}
      <Link className={buttonClassName("quiet", "mt-5")} href="/connections">
        Go to connections
      </Link>
    </section>
  );
}
