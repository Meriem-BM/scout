# Privy authentication

Scout uses `@privy-io/react-auth` 3.40.0 and `@privy-io/node` 0.34.0. Privy is the only interactive authentication provider. Supabase remains the database and private artifact store; monitoring, delivery jobs, and transaction reconciliation continue without a browser session.

## Configure the web

1. Create or select the intended application in the [Privy Dashboard](https://dashboard.privy.io/). Enable email and Google authentication, with wallet login as a secondary method. Add each exact development, staging, and production origin.
2. Set `NEXT_PUBLIC_PRIVY_APP_ID` and optional `NEXT_PUBLIC_PRIVY_CLIENT_ID` in the web build environment. Set `PRIVY_APP_SECRET` only on the server. Enable identity tokens so Scout can read a verified account email; otherwise the server retrieves the user from Privy.
3. Optionally set `PRIVY_VERIFICATION_KEY` to the app's PEM public verification key. Without it, the SDK uses Privy's JWKS. Never use a test key in a shared or production environment.
4. Keep `NEXT_PUBLIC_SUPABASE_URL` and server-only `SUPABASE_SERVICE_ROLE_KEY`. Set `SCOUT_SITE_URL` to the exact canonical origin.

Every sign-in action opens Privy's modal over the current Scout screen. There is no Scout sign-up page, `/signin` route, or second provider chooser. The selected Privy app controls the available methods. Scout disables automatic embedded-wallet creation; Uniswap actions still require an explicitly connected wallet, account and network validation, and user signatures.

Missing credentials show setup required. The runtime contains no demo credential, fabricated login, or anonymous account fallback. Update the web CSP deliberately if a custom Privy domain is configured.

## Session and data authorization

The client waits for Privy to restore its session, then posts a fresh access token and identity token to `/api/auth/session`. Protected requests obtain a current access token so the SDK can refresh it. Scout verifies the ES256 signature, issuer, audience, expiration, subject, and session ID on the server. Identity tokens never authorize requests.

A finite `scout_account_rpc` gateway, callable only with the Supabase service role, maps the verified Privy subject and session to a stable Scout UUID. It sets transaction-local owner claims for existing ownership-checked RPCs. The browser never receives the service key and cannot choose an account UUID. Privy JWTs are never forwarded to Supabase as substitutes for its native `auth.uid()` claims.

Logout revokes the current Privy session ID in Scout before SDK logout. Private requests are aborted on account changes, stale responses are ignored, and each account receives a fresh query cache. Anonymous composer text and a validated relative return destination survive login cancellation and page refresh. Notification consent and Telegram pairing remain separate from authentication.

## Existing accounts and release order

Apply the Privy migration and `202609090001_remove_deprecated_auth.sql` with the matching web release. Existing account UUIDs, watch ownership, incidents, deliveries, and stored Privy mappings remain unchanged. The release removes the retired public account-linking RPCs, challenge table, Supabase OTP callback route, and automatic legacy-account trigger. It does not delete historical product data.

The application never merges users because their email addresses match. If an existing production account lacks a verified Privy mapping, handle it as an operator-reviewed migration before cutover and record the proof and exact UUID mapping outside the public application. There is no browser account-linking endpoint or OTP callback. Old Supabase JWTs and direct browser Data API calls cannot authorize Scout operations.

## Verification

Run against the disposable local Supabase project only:

```sh
pnpm db:start
pnpm db:migrate
pnpm db:types
pnpm test:auth
pnpm test:db
pnpm test:db:connections
pnpm test
pnpm typecheck
pnpm lint
pnpm test:e2e
pnpm build
```

`test:auth` starts an isolated Next process with ephemeral ES256 keys and the installed Privy verifier. It covers token validation, identity-token binding, separate email/Google/wallet identities, no email-only merge, cross-user isolation, origin-checked logout, session revocation, and ownership restoration through a new session. Test credentials are not accepted by the normal application and are not evidence of live provider login.

Before release, verify email and Google login with the configured Privy app and an authorized identity, including cancellation, reload, expiry recovery, logout, and returning to a drafted watch or canonical watch-scoped incident URL. Authorize notification tests and wallet transactions separately.
