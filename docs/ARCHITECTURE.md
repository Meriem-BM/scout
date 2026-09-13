# Architecture and invariants

Scout separates data acquisition from deterministic monitoring. The browser does not execute Watches; it submits requests and reads durable state. The worker owns provider sessions, builds, investigation and delivery.

## Execution path

1. The model returns schema-validated typed intent. Unknown model fields are rejected, including keys a permissive object parser would strip. Canonical metadata/user input constrains addresses; declared material defaults require clarification.
2. The workflow persists intent, clarification, data requirements, inspected packages and plans. Build/provider-session admission requires a validated WatchProgram bound to the immutable Watch version.
3. The supported acquisition adapters supply normalized finalized observations. Package integrity, canonical RPC evidence and historical references are checked independently of model claims.
4. The generic evaluator applies typed filters, exact-number comparisons, grouping, windows and aggregations. It makes no model calls.
5. Required history is resolved through a typed provider. Immutable findings and revision-bound decisions retain their evidence. Existing outboxes handle delivery and retry.

## Current boundaries

- Ethereum Uniswap V3 WETH/USDC swaps and Base canonical USDC transfers are the verified source paths. Other understood intents can remain unavailable.
- Base runs the real parameterized published event module. Uniswap uses trusted composition. Arbitrary generated code is disabled; the trusted host build is not a sandbox for untrusted Rust.
- Explicit Uniswap pool scope is preserved. The installed pool catalog is not complete factory discovery. Liquidity events, LP positions and V4 remain unsupported.
- Programs can express rolling counts, sums, averages, extrema, median, distinct values and observed deltas. General public deployment and generated acceptance for every composition remain unfinished.
- The existing executable-spec compiler and Uniswap incident delivery still have production callers. Uniswap event conditions use the generic evaluator through a compatibility boundary; older volume-baseline logic retains its reader. These cannot be removed without a separate behavior-preserving data/runtime migration.
- There is no installed shared-stream supervisor. Each deployment consumes its own bounded provider session. Generic window recovery uses database program events and checkpoints, not an in-memory snapshot service.

## Truth and verification

Authority runs from checked chain evidence and deterministic capability metadata to inspected package descriptors, validated program, model interpretation and free-form text. Lower-authority output cannot prove higher-authority facts.

- Historical FOUND requires a previous evidence transaction. NONE_WITH_PROVEN_COVERAGE requires matching complete coverage. Missing, conflicting or failed required context remains pending; it is never silently absence.
- First-time V3 activity is not first-ever chain activity, wallet age, beneficial ownership or intent.
- Valuation retains source/block/time. Canonical USDC transfer thresholds use nominal token denomination, not a universal oracle. Missing/stale valuation cannot create a USD match.
- Pipeline verification and controlled Watch acceptance are distinct. The real-provider proof records actual chain observations separately from controlled boundary mutations.
- Explanation generation may select known limitation IDs; factual sentences and numeric values remain deterministic. Model prose cannot change alert/suppress. Older stored explanations have not all been rewritten.
- Healthy/live status derives from verified deployment, heartbeat and progress. Persisted status alone is insufficient. A unified activation-proof record for every historical Watch is still missing.

## Persistence and recovery

Watch versions and program identities are immutable. Canonical event IDs include chain, block hash, transaction hash and event index. Per-Watch membership and grouping isolate state. Findings retain triggering events; actor-dependent legacy incidents preserve actor identity.

Worker jobs and pipeline leases carry generations. Critical writes are fenced against stale owners; evidence revisions prevent late investigations overwriting newer decisions. Clarification invalidates dependent outputs. Cursor advancement and observation persistence occur transactionally.

Provider sessions are budgeted across workers sharing the database, with verification capacity reserved. Reconnects resume saved cursors. Replays deduplicate events, decisions and deliveries. Required Graph failure retries investigation without inventing an alert. Delivery transport timeouts can remain ambiguous rather than being blindly resent.

The hot path is deterministic. Reads/retention are bounded; high-volume throughput and shared-session fan-out are not claimed as completed performance work.

## Ownership and server boundaries

Privy access tokens are verified server-side. Owner-scoped gateways and database constraints protect Watch data; service credentials never belong in browser bundles. The worker uses PostgreSQL directly; artifacts live in private Supabase Storage. Public endpoints and webhooks validate payloads and provider signatures through their existing adapters.

Core domain operations remain pure. Integrations own external schemas, addresses, RPC/package inspection and provider error mapping. UI status projections explain persisted truth rather than simulate workflow progress.

## Review evidence

- [Uniswap integration](UNISWAP-INTEGRATION.md) and [actual event/acceptance artifact](evidence/uniswap-integration.json).
- [Recorded Base/Uniswap correctness evidence](evidence/correctness-2026-09-13.json), with live and controlled cases labeled separately.
- [Authentication](AUTHENTICATION.md), [deployment](DEPLOYMENT.md), [dependency provenance](DEPENDENCIES.md).

The remaining compiler/incident migration, composed acceptance generation, generic investigation scheduling and activation proofs are active limitations. Passing unit tests is not evidence that these missing pieces exist.
