# Deployment

Verified documentation: **September 9, 2026**. Target: one Vercel Next.js application, one Supabase project, and one Northflank Combined Service running the worker image. No resources were provisioned during implementation. The steps that create services, register webhooks, add a payment method, or enable billing are operator actions, not already completed work.

## Release order

1. Obtain the credentials below and choose nearby Supabase/Northflank/Vercel regions. Back up any existing database. Use separate staging and production credentials.
2. Create the Supabase project, apply migrations, verify RLS/Storage, and configure email.
3. Deploy the web with its exact public URL and server-only variables. Configure allowed Auth redirects.
4. Build and deploy one Northflank Combined Service from `Dockerfile.worker`. Confirm its liveness probe, readiness probe, worker heartbeat, and real provider connectivity.
5. Register Telegram and Resend webhooks, pair Telegram and/or verify an email destination, and explicitly request labeled tests to your own destinations. Run the bounded Graph/Substreams smoke. Activate a real watch and inspect its persisted technical proof/current checkpoint.
6. Record live incident/enrichment/delivery evidence. Obtain a real Uniswap quote without signing. Any financial broadcast is a separate explicit user decision; never put it in CI.

## Environment and credentials

Copy values into provider secret settings, not the repository. [Web template](../apps/web/.env.example), [worker template](../apps/worker/.env.example), [CLI map](../.env.example).

| Variable                                                  | Web                          | Worker                      | Source / purpose                                                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_PRIVY_CLIENT_ID` | Public web build settings    | No                          | Privy Dashboard; client ID optional                                                                                                                                                      |
| `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY`              | Server secrets; key optional | No                          | Privy Dashboard; omit verification key to use JWKS                                                                                                                                       |
| `NEXT_PUBLIC_SUPABASE_URL`                                | Public project origin        | No                          | Supabase Project Settings → API                                                                                                                                                          |
| `SUPABASE_URL`                                            | No                           | Required                    | Same project URL                                                                                                                                                                         |
| `SUPABASE_SERVICE_ROLE_KEY`                               | Secret                       | Secret                      | Restricted server/worker access, never `NEXT_PUBLIC_`                                                                                                                                    |
| `DATABASE_URL`                                            | No                           | Secret                      | Direct or session-pooler Postgres URL with TLS                                                                                                                                           |
| `ETHEREUM_RPC_URL`                                        | Secret                       | Secret                      | Ethereum mainnet archive/historical calls, finalized blocks, code, transaction and simulation support                                                                                    |
| `GRAPH_API_KEY`                                           | Secret                       | Secret                      | [Subgraph Studio](https://thegraph.com/studio/), bounded historical queries                                                                                                              |
| `GRAPH_SUBGRAPH_ID`                                       | Optional                     | Optional                    | Defaults to the documented Ethereum v3 identity in Integrations                                                                                                                          |
| `SUBSTREAMS_API_KEY` or `SUBSTREAMS_API_TOKEN`            | No                           | Secret                      | [The Graph Market](https://thegraph.market/) data-plane authorization, distinct from the Studio query key; current API keys use a provider-issued mobile/server/web/worker/hosted prefix |
| `SUBSTREAMS_ENDPOINT`                                     | No                           | Required/default            | Provider supporting Ethereum mainnet and this package; default StreamingFast endpoint                                                                                                    |
| `GROQ_API_KEY`, `GROQ_MODEL`                              | Secret / model ID            | Secret / model ID           | [Groq Console](https://console.groq.com/keys); intent resolution and optional incident explanation                                                                                       |
| `UNISWAP_API_KEY`                                         | Secret                       | No                          | [Uniswap developer dashboard](https://developers.uniswap.org/dashboard/) Trading API access                                                                                              |
| `TELEGRAM_BOT_TOKEN`                                      | Secret                       | Optional secret             | [BotFather / official tutorial](https://core.telegram.org/bots/tutorial)                                                                                                                 |
| `TELEGRAM_BOT_USERNAME`                                   | Server config                | No                          | Exact bot username, without `@`                                                                                                                                                          |
| `TELEGRAM_WEBHOOK_SECRET`                                 | Secret                       | No                          | At least 32 random URL-safe characters, same as registered webhook secret                                                                                                                |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL`                     | Server only                  | Optional server credentials | Resend API key and verified alert sender                                                                                                                                                 |
| `RESEND_WEBHOOK_SECRET`                                   | Secret                       | No                          | Resend signing secret; exact raw request verification                                                                                                                                    |
| `EMAIL_LINK_SECRET`                                       | Secret                       | Same secret                 | Random 32+ characters for destination-only disable links                                                                                                                                 |
| `SCOUT_SITE_URL`                                          | Required                     | Required                    | Exact canonical HTTPS origin, no preview-domain wildcard                                                                                                                                 |

The worker needs Graph, Ethereum RPC, database/Storage and Substreams access to start. Telegram and email delivery remain optional; existing watches that lose delivery continue monitoring with a warning. Groq is required to resolve a new natural-language intent. If its key is absent, the worker stays available for existing deterministic processing and the new workflow fails at `INTENT_RESOLVING` with `GROQ_SETUP_REQUIRED`. The web also needs the Groq key for its authenticated interpretation and investigation endpoints. Empty environment values should be omitted for optional worker fields.

## Supabase

Local commands (`pnpm db:start`, `pnpm db:migrate`, `pnpm db:types`) target the local Postgres 17 stack. `db:start` stages only public config, migrations and email templates in an OS temporary directory: Docker Desktop could not mount files from this Mac's protected Documents folder. It starts the required local services without optional Studio/edge/log services. Persistent database/storage stay in named Docker volumes; never remove the temporary template directory while its containers are running. `db:stop` discovers the same project by ID and preserves its volumes. For a newly authorized cloud project:

```sh
pnpm exec supabase login
pnpm exec supabase link --project-ref YOUR_PROJECT_REF
pnpm exec supabase db push --dry-run
pnpm exec supabase db push
```

Review the project reference and migration plan before pushing. Apply migrations as a release step, never from every worker replica. Generate checked-in types with `pnpm db:types` against the same local migrations; CI checks for type drift.

The migration creates the **private** `pipeline-artifacts` bucket, maximum 50 MB per object. Browser roles cannot list/read/write its objects. The authenticated proof endpoint checks ownership then issues 60-second signed links for the exact artifact. Never make the bucket public. RLS remains enabled, but browser roles have no direct table/RPC grants after the Privy cutover; the verified server gateway enforces ownership; private worker state is not exposed by the API. Use `pnpm test:db` only against the empty disposable local project, not your cloud instance.

Use a direct Postgres connection or Supabase **session pooler** on port 5432 for the long-lived worker; choose session pooling if the host cannot reach direct IPv6. Include TLS (`sslmode=require`) in production. The web uses Supabase HTTPS APIs, so it does not hold an unbounded serverless Postgres connection pool. Worker SQL uses bounded connections and disables prepared statements for pooler compatibility. [Connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres).

### Authentication and email

Configure Privy email, Google, and optional wallet login following [Authentication setup](AUTHENTICATION.md). Set the public app ID at build time and the server app secret at runtime. Use exact trusted origins in Privy and `SCOUT_SITE_URL`; enable identity tokens. Wallet creation is disabled in the SDK configuration.

Apply the Privy migrations, including `202609090001_remove_deprecated_auth.sql`, and `202609090002_protocol_profiles.sql` with the matching web release. They preserve account UUIDs and product data, revoke legacy browser Data API access, remove the retired Supabase OTP linking surface, and expose the persisted generic intent in owner-scoped Watch projections. Never forward Privy tokens to old Supabase RLS policies or roll back only the web binary. See the migration and rollback notes in the authentication guide.

## Vercel

Import the repository when publication is authorized. Set **Root Directory `apps/web`**, Next.js framework, Node **24.x**, and allow build access to files outside the root directory for workspace packages. `apps/web/vercel.json` runs a workspace-root frozen install then `pnpm build` in the web app. Add public Auth values at build time; add server variables only to the appropriate deployment environment. Set the production URL in `SCOUT_SITE_URL`; update Auth redirects when domains change.

Node 24.20.0 is pinned for local/CI/Docker reproducibility; Vercel selects a supported major and manages the patch. Verify the deployed runtime patch in build logs instead of claiming control over Vercel's patch selection.

With Fluid Compute, current limits are 300 seconds on Hobby and up to 800 stable seconds on Pro/Enterprise. Scout uses only bounded 30/60-second handlers, not beta extended limits, post-response tasks or a stream in a function. Plan quotas and invocation cost still apply. [Current limits](https://vercel.com/docs/functions/limitations).

Verify `/api/health`, sign-in, draft preservation, cross-account denial, and a private authenticated response's `Cache-Control`. The health endpoint proves process liveness, not working Graph or Uniswap credentials.

## Northflank worker

Use a Northflank **Combined Service** named `scout-worker`. A Combined Service builds and deploys the tracked Git branch as one CI/CD unit. Connect the authorized repository and configure these values:

| Setting             | Value                                                                  |
| ------------------- | ---------------------------------------------------------------------- |
| Deployment target   | Northflank Cloud                                                       |
| Build type          | Dockerfile                                                             |
| Dockerfile          | `/Dockerfile.worker`                                                   |
| Build context       | `/`                                                                    |
| Build engine        | BuildKit                                                               |
| Instances           | `1`                                                                    |
| Container command   | Use the Dockerfile command                                             |
| Port                | HTTP `8080`; public exposure is optional                               |
| Startup/liveness    | HTTP `GET /health/live` on port `8080`                                 |
| Readiness           | HTTP `GET /health/ready` on port `8080`, 30-second initial delay       |
| Persistent volume   | None; durable artifacts and checkpoints are stored in Supabase         |
| Runtime environment | Inject the worker variables from the table above through secret groups |

Keep CI and CD enabled for the intended branch and use one instance. Do not run another worker against the same production database. Northflank can discover `EXPOSE 8080` from the Dockerfile, and its probes can use the port without making it public. Public exposure is useful only when an external uptime monitor needs the minimal health routes. [Combined Service setup](https://northflank.com/docs/v1/application/getting-started/build-and-deploy-your-code), [health checks](https://northflank.com/docs/v1/application/observe/configure-health-checks).

The Dockerfile bundles the pinned Substreams CLI, checksummed reusable package, Rust/Cargo toolchain and offline dependency caches used for per-workflow compilation, plus production workspace dependencies. The CLI is also a runtime dependency: activation verification invokes RPC v3 with fixed arguments in a size- and range-bounded temporary workspace, while the persistent sink consumes finalized near-head output. Runtime uses the non-root `node` user; no application secret is present in a build stage. Docker AMD64/ARM64 download branches are supported. Northflank must receive the repository-root build context so it can copy every workspace package, not only `apps/worker`.

Start with the Developer Sandbox compute allocation and inspect the first real workflow. The free plan is intended for evaluation, hobby projects, and testing rather than production. Runtime compilation of a newly generated Rust pipeline is the highest-memory stage; if the container is terminated or reports an out-of-memory build, increase compute or move this unchanged image to a larger Docker host. Scout records that as a build failure and must not advance the Watch to `LIVE`. Northflank currently requires a payment method even on the free plan. [Northflank pricing guidance](https://northflank.com/docs/v1/application/billing/pricing-on-northflank).

After deployment, verify both health routes from the container view, then inspect the structured `worker.started` and heartbeat logs. A passing health route proves the worker and database lease loop are ready; the release gate still requires the credential-gated Graph/Substreams smoke and an advancing real checkpoint.

The same image runs on another Docker host without code changes:

```sh
docker build -f Dockerfile.worker -t scout-worker:0.1.0 .
docker run --name scout-worker --init --restart unless-stopped \
  --env-file apps/worker/.env --memory 2g --cpus 1 \
  -e SUBSTREAMS_TEMPLATE_DIR=/app/substreams \
  -p 127.0.0.1:8080:8080 scout-worker:0.1.0
```

An env file can override Docker defaults; use the absolute template path shown. Keep port 8080 private unless exposing the minimal health endpoint intentionally. Do not run a second unmanaged worker against production while testing. The local `pnpm test:container` deliberately uses only an empty local database and no valid external credentials.

## Telegram registration and delivery

Set the canonical HTTPS origin, bot token/username, and matching random webhook secret in the web environment; set bot token/site URL on the worker. Only after explicitly approving a bot configuration change:

```sh
node --env-file=apps/web/.env.local --import tsx scripts/telegram-webhook.ts --register
```

This calls official `setWebhook` with the secret token and only message/callback updates, without discarding pending updates. The helper does not print credentials. In Connections, use **Connect Telegram**, start the bot through the generated short-lived deep link, return to see verified connection, then request **Send test alert**. Check persisted test status and actual receipt. A typed username does not pair an account. [Official bot deep links](https://core.telegram.org/bots/features#deep-linking).

## Resend alert email

This is separate from Privy sign-in and its consent. Use one verified sender domain/subdomain in [Resend Domains](https://resend.com/docs/dashboard/domains/introduction), configure the required DNS records and wait for verification. Create a sending API key restricted to that domain where supported. Put `RESEND_API_KEY` and `RESEND_FROM_EMAIL` (for example `Scout <alerts@your-domain.example>`) in both web and worker secrets. Put the same random `EMAIL_LINK_SECRET` of at least 32 characters in both. Rotating this secret invalidates older destination-disable links; reconnecting/replacing a destination rotates its identity as well.

Register `https://YOUR_CANONICAL_ORIGIN/api/email/webhook` in Resend for `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.failed`, `email.bounced`, `email.complained`, and `email.suppressed`. Copy its signing secret into web `RESEND_WEBHOOK_SECRET`. The handler verifies the **raw** request with the pinned SDK and Svix headers before persisting only event metadata. It deduplicates event IDs and reconciles events arriving before the send API response. [Event types](https://resend.com/docs/webhooks/event-types), [signature verification](https://resend.com/docs/webhooks/verify-webhooks-requests).

In Connections, explicitly use your verified account email or request verification at a different address. New links expire after ten minutes and must be confirmed by the owning signed-in account. Existing destinations stay in place while a replacement is pending. The link token is carried in a URL fragment, hashed for verification and cleared from private queued verification payloads after acceptance or expiry. Do not log request bodies, fragments or queued mail payloads.

Choose default enabled destinations in Settings, or override Telegram/email in a watch's Alert destinations control. A disconnect explains that monitoring continues while that destination stops receiving alerts. A **Send test alert** action is labeled, rate-limited and addressed only to the verified destination. Verify the provider's actual message ID/event and the recipient mailbox before claiming public delivery. There is no fabricated success when credentials are absent.

The worker claims existing Postgres jobs; Vercel never runs retry timers. Each email has a permanent application dedupe key and stable provider idempotency key/payload. Resend retains keys for 24 hours; Scout stops retrying an uncertain request after 23 hours and records an unknown result instead of risking a duplicate. API acceptance is `sent`; only signed provider events can produce `delivered`. Bounces/complaints suppress the address; a later delivery event cannot clear suppression. [Idempotency contract](https://resend.com/docs/dashboard/emails/idempotency-keys).

Release migrations **005–009**, the Privy/workflow migrations, `202609090001_remove_deprecated_auth.sql`, and `202609090002_protocol_profiles.sql` before the updated web/worker. They preserve watch versions, incidents, Telegram records, account UUIDs and delivery history while introducing the current private authentication, notification, and protocol-intent projections. Pause older workers during this release: pre-email workers are not compatible with multi-channel delivery rows. Do not roll back to one without a reviewed compatibility migration. Rebuild the worker image after adding Resend; an older image is not evidence for this release.

## Readiness and live release gate

Run `pnpm test:live` with worker credentials (see Integrations); set `REQUIRE_LIVE=1` for a genuine gated check. Missing credentials must fail that release gate. Then activate one watch in the web app. Confirm package/source hashes, real provider-range output, Subgraph block identity, deployment state and advancing current checkpoint in its technical proof.

Close the browser. Wait for a naturally qualifying finalized event, or explicitly choose and review a lower demonstration threshold—never fabricate an alert. Confirm watch-scoped incident evidence, actual Telegram acceptance and/or verified email delivery events, and Graph context. API acceptance alone is not inbox arrival or a read receipt. Restart the worker; prove cursor advancement without duplicate evidence or another first-alert send. A bounded smoke alone does not prove this full lifecycle.

Check provider quota/billing dashboards and Supabase project health before judging. Free projects may be paused after inactivity, usage limits apply, and email/provider/Northflank charges are separate. Northflank's Developer Sandbox is an evaluation tier, not the production capacity recommendation. [Supabase production guidance](https://supabase.com/docs/guides/platform/going-into-prod).

## Rollback

Record the web deployment ID, worker image digest and applied migration IDs. For an application regression, stop or pause affected monitoring, restore the prior known-compatible worker image and Vercel deployment, and verify heartbeat/cursors. Do not delete checkpoints or reset the database. A stale pipeline lease expires in forty seconds. Pending jobs are retried from durable state; ambiguous Telegram sends are not resent automatically.

Migrations are additive; prefer a forward corrective migration. Before any destructive schema rollback, take a backup and review data compatibility explicitly. Never automatically downgrade an immutable watch specification or rewrite source proof. A watch edit keeps the previous version working until its replacement is ready. Provider outages should remain delayed or failed and must never turn into fixture success.
