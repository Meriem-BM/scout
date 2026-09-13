"use client";

import { Settings as Cog6ToothIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useScoutAuth } from "../account/auth-context";
import { SignInButton } from "../account/sign-in-button";

import { buttonClassName, iconButtonClassName } from "./primitives";
import {
  ConnectionsSkeleton,
  WatchDetailSkeleton,
  WatchesSkeleton,
} from "./skeletons";
import { ErrorNotice } from "./ui";
import { useWorkspace } from "./use-workspace";

export function Shell({ children }: { children: React.ReactNode }) {
  const { signedIn, loading, error, state, refresh } = useWorkspace();
  const path = usePathname();
  const auth = useScoutAuth();
  const isPublic =
    path === "/" ||
    path === "/capabilities" ||
    path === "/docs" ||
    path.startsWith("/docs/");
  const isWatchesHome = path === "/watches";

  return (
    <div
      className="app-shell"
      data-background={isWatchesHome ? "dark-purple" : undefined}
      data-testid="workspace-frame"
    >
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="app-header">
        <div className="header-inner">
          <Link
            href={isPublic ? "/" : "/watches"}
            className="brand"
            aria-label="Scout home"
          >
            Scout
          </Link>
          <nav aria-label="Primary">
            {isPublic ? (
              <>
                <Link href="/docs/how-it-works">How it works</Link>
                <Link href="/docs">Docs</Link>
                <Link href="/watches">Launch app</Link>
              </>
            ) : (
              <>
                <Link
                  href="/watches"
                  aria-current={
                    !path.includes("connections") && !path.includes("settings")
                      ? "page"
                      : undefined
                  }
                >
                  Watches
                </Link>
                <Link
                  href="/connections"
                  aria-current={
                    path.includes("connections") ? "page" : undefined
                  }
                >
                  Connections
                </Link>
              </>
            )}
          </nav>
          {!isPublic && (
            <div className="header-account">
              {!auth.ready || auth.restoring ? (
                <span
                  className="account-restoring"
                  role="status"
                  aria-label="Restoring session"
                >
                  <span aria-hidden="true" />
                </span>
              ) : !signedIn ? (
                <SignInButton
                  className={buttonClassName("quiet")}
                  destination={path}
                >
                  Sign in
                </SignInButton>
              ) : (
                <span className="account-indicator">
                  <span />
                  Personal workspace
                </span>
              )}
              <Link
                href="/settings"
                className={iconButtonClassName}
                aria-label="Settings"
              >
                <Cog6ToothIcon className="size-5" />
              </Link>
            </div>
          )}
        </div>
      </header>
      <main
        id="main"
        className={`app-main ${isWatchesHome ? "app-main-watches" : path.includes("settings") || path.includes("connections") ? "app-main-preferences" : /\/watches\/[^/]+|\/incidents\//.test(path) ? "app-main-detail" : ""}`}
        tabIndex={-1}
      >
        {!isPublic && error && (
          <div className="mb-6">
            <ErrorNotice message={error} />
            <button
              className={buttonClassName("quiet")}
              onClick={() => void refresh()}
            >
              Retry workspace
            </button>
          </div>
        )}
        {!isPublic && loading && state.watches.length === 0 ? (
          isWatchesHome ? (
            <WatchesSkeleton />
          ) : path.includes("settings") || path.includes("connections") ? (
            <ConnectionsSkeleton />
          ) : (
            <WatchDetailSkeleton />
          )
        ) : (
          children
        )}
      </main>
      {path !== "/" && (
        <footer className="app-footer">
          <span>
            <span className="status-dot" /> Autonomous onchain monitoring
          </span>
          <Link href="/docs">How Scout works ↗</Link>
        </footer>
      )}
    </div>
  );
}
