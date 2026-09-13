# Uniswap integration proof

**Uniswap provides data semantics. Scout provides monitoring semantics.**

Scout currently acquires verified Ethereum Uniswap V3 WETH/USDC swaps. Those observations normalize into the same event envelope and run through the same evaluator as Base transfers. Reusable reference programs demonstrate thresholds, direction, actor grouping, historical eligibility and combined value. Ethereum V4 signed liquidity changes now have a separate data adapter feeding that same evaluator; healthy LIVE verification is pending provider capacity.

## Supported surface

| Capability                                               | Status                                        | Boundary                                                                                                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V3 swaps                                                 | IMPLEMENTED                                   | Ethereum WETH/USDC, installed 0.05% and 0.30% pools, finalized Substreams observations with independent RPC/valuation checks.                                                                                                 |
| Specific pool / fee tier                                 | IMPLEMENTED in reusable scope resolver        | Explicit selection from the verified catalog; persisted in the reference evidence artifact and represented by program source contracts. Existing public workflow retains its explicit pool clarification/version persistence. |
| All matching pair pools                                  | PARTIAL                                       | Represented explicitly, returns NEEDS_DATA_RESOLUTION. The two installed pools are not claimed to cover all fee tiers. Full factory discovery and acquisition verification are required. No arbitrary pool fallback.          |
| ETH buy / sell programs                                  | IMPLEMENTED                                   | WETH asset movement direction, not transaction method names or prose regex. ETH means wrapped ETH in these V3 pool observations.                                                                                              |
| Prior V3 actor activity                                  | IMPLEMENTED                                   | RPC transaction initiator, Graph query and verified historical coverage. This is not wallet age, first-ever onchain use, ownership, or prior V2/V4 activity.                                                                  |
| Three sellers in 15 minutes                              | PARTIAL                                       | Compiles to rolling window + unique actors in the generic engine; controlled acceptance passes. General composed-program public deployment remains unfinished.                                                                |
| Three first-time V3 actors, combined $500K in 15 minutes | PARTIAL                                       | Generic history eligibility before count/sum; controlled acceptance passes. No new live composed Watch or delivery is claimed.                                                                                                |
| Mint / liquidity additions                               | UNSUPPORTED                                   | Existing protobuf/WASM stream emits swaps only. No acquisition/reference verification for Mint is installed.                                                                                                                  |
| Burn / liquidity removals                                | UNSUPPORTED                                   | No verified Burn stream or withdrawn-value semantics. The liquidity-removal reference returns unavailable with the missing capability.                                                                                        |
| PoolCreated                                              | UNSUPPORTED                                   | Factory event acquisition and catalog completeness are not implemented in the current stream.                                                                                                                                 |
| LP position ownership/accounting                         | UNSUPPORTED                                   | No verified NFT-manager/position lifecycle provider. Pool events cannot establish beneficial ownership.                                                                                                                       |
| V4 ModifyLiquidity                                       | PARTIAL end-to-end; data capability AVAILABLE | Published package reuse, independent historical verification, Initialize resolution and generic findings implemented. Healthy LIVE/cursor-resume provider proof remains blocked on session capacity.                          |

## Reusable code

- [Data adapter contract and Uniswap adapter](../packages/integrations/src/data-adapters.ts): capability matching, normalization and verification hints. The live proof now uses `uniswapDataAdapter` directly.
- [Typed scope and program compiler](../packages/domain/src/uniswap/programs.ts): `resolveUniswapScope`, `compileUniswapProgram`, `uniswapReferencePrograms`. This module constructs existing IR primitives; it contains no event evaluator or bespoke detector.
- [Catalog](../packages/domain/src/uniswap-scope.ts): chain-specific contracts, tokens, fee tiers and valuation feeds.
- [Substreams decoder](../substreams/src/lib.rs), [protobuf](../substreams/proto/scout.proto), [RPC normalization](../packages/integrations/src/substreams.ts), [normalized compatibility boundary](../packages/domain/src/monitoring/compatibility.ts).
- [Capability registry](../packages/domain/src/monitoring/capabilities.ts), [semantic validator](../packages/domain/src/monitoring/validation.ts), [generic evaluator](../packages/domain/src/monitoring/runtime.ts).
- [Typed historical provider](../packages/integrations/src/investigation-provider.ts), [Graph implementation](../packages/integrations/src/graph.ts). Provider exceptions become ERROR_RETRYABLE with no fabricated coverage.
- [Real pipeline verification](../apps/worker/src/pipeline/build.ts), [generic acceptance generator](../packages/domain/src/monitoring/acceptance.ts).
- [Controlled reference tests](../tests/unit/uniswap-programs.test.ts), [real adapter proof](../tests/live/program-uniswap.ts), [machine-readable evidence](evidence/uniswap-integration.json).

A consumer can reuse the normalized adapter and history provider independently of Scout's UI. The program compiler, schema, capability checks and evaluator are source modules in the MIT-licensed workspace, not a separately published SDK. Reusing them requires their documented RPC/Graph/Substreams configuration and dependencies.

## Reference programs

```ts
import { uniswapReferencePrograms } from "@scout/domain";

const examples = uniswapReferencePrograms({ kind: "fee_tier", fee: 500 });
// examples.buys.program
// examples.firstTimeBuys.program
// examples.distinctSellers.program
// examples.firstTimeCombinedBuys.program
// examples.liquidityExits.program === null
```

The scope is explicit in this example; it does not mean all WETH/USDC activity on Uniswap. Calling with `{ kind: "all_matching" }` preserves the request and reports missing complete data resolution.

The composed reference uses:

```text
swap → selected asset direction = buy
     → prior V3 actor activity = proven absence (eligible events)
     → rolling 900-second window, grouped by asset
     → unique(actor) >= 3 AND sum(valueMicros) >= 500000000000
     → generic deterministic match
```

Every actor must have the required history established before it contributes. UNKNOWN or ERROR_RETRYABLE keeps the decision pending. A transaction initiator is an observed chain identity, not proof of a distinct human or common ownership.

A/B use strict `>` for “above $100K”; the combined reference uses `>= $500K`. Numeric comparison is performed by the existing exact-integer runtime. No natural-language sentence is recognized by a custom monitor function.

The public natural-language resolver remains the existing typed intent compiler. These reference builders are reusable typed compiler fixtures, not a second natural-language resolver. Public creation of arbitrary composed programs remains a known architecture gap; this change does not disguise it as live support.

## Verification evidence

The real proof fetched this canonical Ethereum event through the actual stored Substreams artifact and reusable adapter:

- Block **25,956,038**.
- Transaction [`0x23f0fd8162cdb7f95c3cd728faf65ffb033a9382ae0b6c234fd5d3341a437c55`](https://etherscan.io/tx/0x23f0fd8162cdb7f95c3cd728faf65ffb033a9382ae0b6c234fd5d3341a437c55), event index **9**.
- Pool `0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640`.
- Final artifact SHA-256 `8cdcd3c57a14f84d54a254f0da2771ef7249308f043e8915c155e81c251a5637`, output module `map_watch`.
- Missing history → PENDING_CONTEXT. Actual Graph FOUND → NO_MATCH for the first-time requirement.
- The same real event matched the plain ETH-buy amount program. Controlled first-time/history boundary cases are recorded separately from the actual FOUND result.
- The amount/direction program's generated boundary cases passed using controlled mutations of that real normalized seed. These mutations are explicitly labeled CONTROLLED_FROM_SEED; they are not additional observed transactions.
- The run made no external delivery and did not activate a new Watch.

A verifier bug found during this proof was fixed: wrong-asset acceptance must change the program's selected asset, not assume it is the first item in a multi-asset event.

Controlled tests separately cover buy/sell rejection, below threshold, wrong pool, proven absence, previous activity, unknown/retryable context, actor counts, expiration, cross-token isolation and duplicate replay. The composed scenarios are **not real-chain multi-actor success evidence**. A real first-time actor with defensible complete coverage was not newly observed in this run.

Validation: 197 TypeScript tests, six Rust tests, workspace typecheck and targeted ESLint passed. No generic runtime changes or new UI were needed. The narrow tracked-file private-key pattern scan found no matches; this does not replace a full history/dependency audit before publication.

Run with configured private provider credentials:

```sh
pnpm exec tsx --env-file-if-exists=apps/worker/.env tests/live/program-uniswap.ts
pnpm exec vitest run tests/unit/uniswap-programs.test.ts tests/unit/watch-program.test.ts
```

The script writes a public, credential-free proof artifact at `docs/evidence/uniswap-integration.json`. It also requires the previously verified local pipeline/artifact and saved event fixture described in the script; it is not a credential-free public demo.

## Substreams and Graph dependencies

The production V3 path composes checksum-pinned `ethereum-common@v0.3.3` event infrastructure with Scout's trusted normalization modules. It does not generate arbitrary Rust. Existing build verification compares real historical output against independent chain/Subgraph references. RPC binds block identity and transaction initiator; Chainlink data binds input-side trade notional to a price source/block/timestamp. Value is not an output-side slippage or profit calculation.

Graph prior-activity queries require a checked deployment and coverage boundary. An empty query alone never proves absence. `FOUND`, `NONE_WITH_PROVEN_COVERAGE`, `UNKNOWN` and `ERROR_RETRYABLE` remain distinct at the normalized provider boundary.

Recent pool context exists in the older Graph incident adapter, with sample/coverage limits; it has not been registered here as a new generic historical count/baseline capability. Do not infer complete history from a limited recent sample.

## V4 liquidity changes

**IMPLEMENTED:** `UNISWAP_V4_LIQUIDITY_CHANGE`. Ethereum V4 `ModifyLiquidity` observations normalize into `liquidity_change` events. The generic `metric < 0` predicate means decrease; `metric > 0` means increase. Zero is neither. No token amount or price is fabricated.

- Explicit V4 is required. Generic Uniswap requests require version clarification; V3 is never silently changed to V4.
- A specific bytes32 pool ID is a generic subject filter. PoolKey currencies, fee, tick spacing and hooks come from a canonical `Initialize` log, checked against the pool ID hash.
- Archive storage locates the initialization block using the official PoolManager slot layout; it does not substitute for Initialize evidence. Unavailable history yields UNKNOWN and retries without advancing the cursor.
- `actor` is the receipt's transaction initiator. `sender` is the PoolManager caller. Address-scoped requests must distinguish them; neither proves LP ownership.
- The package emits transaction-local log indexes. The adapter verifies the receipt and stores its canonical block-wide log index.

**Data dependency:** [`uniswap-v4-substreams@v0.1.1`](https://substreams.dev/packages/uniswap-v4-substreams/v0.1.1), `map_events`, Ethereum `mainnet`. Strategy **REUSE** executes the published package directly. SHA-256: `d9e4f57698f153c8782adb7e03c266216143f9f595d37c812c169934b7b44c34`. No generated Rust is involved.

**Real historical evidence:** blocks 25,956,038–25,956,137 emitted 119 ModifyLiquidity events matching independent Ethereum logs. The normal creation workflow also checked all five events in block 25,956,043. Transaction [`0x02cd…4111`](https://etherscan.io/tx/0x02cdc50d570a0133d20c51918e1a54d44dacf76f9055823d1c6b3257e4134111) includes both a negative delta (-11188871758706008) and a positive delta (11182064548530221). The negative event's pool was initialized at block 22,471,726, transaction [`0xc1f9…e78e`](https://etherscan.io/tx/0xc1f97ac427b0aa9fc6153b2146f08d76a282ddc87b539afe82a503673167e78e).

The [recorded evidence](evidence/v4-liquidity.json) separates real chain observations from controlled wrong-pool, unknown-pool and replay cases. A rollback-only database test persisted both recorded events and replayed the negative one: two event records, one immutable finding and one ALERT decision. No external delivery was attempted.

**PARTIAL:** the prompt “Watch liquidity removals from Uniswap V4 on Ethereum” has passed schema/capability planning, actual registry inspection, pipeline verification and Watch acceptance. Its deployment is waiting for the configured live session, currently occupied by an existing Watch. Healthy LIVE, production cursor resume and a finding from the live stream have **not** been demonstrated in this run. Do not treat historical verification as that proof.

**UNSUPPORTED:** `UNISWAP_V4_LIQUIDITY_VALUE`, including “>$500K removed”; V4 prior-activity history; NFT-position ownership; hook-specific accounting. The available ModifyLiquidity event contains liquidity units, not withdrawn currency amounts. Exact principal valuation would need verified event-ordered pool state and tick math, then explicit price evidence; actual received value also needs fee/hook accounting. These are not implemented or approximated. See [the official event contract](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol) and [StateLibrary](https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol).

Reusable source boundaries:

| Responsibility                                             | Source                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Typed V4 scope and compilation                             | [`packages/domain/src/uniswap/v4.ts`](../packages/domain/src/uniswap/v4.ts)                           |
| Data field capabilities                                    | [`packages/domain/src/monitoring/capabilities.ts`](../packages/domain/src/monitoring/capabilities.ts) |
| Receipt verification, Initialize resolution, normalization | [`packages/integrations/src/uniswap-v4.ts`](../packages/integrations/src/uniswap-v4.ts)               |
| Published-package verification and acceptance              | [`apps/worker/src/pipeline/v4.ts`](../apps/worker/src/pipeline/v4.ts)                                 |
| Durable normalized stream ingestion                        | [`apps/worker/src/ingestion/normalized.ts`](../apps/worker/src/ingestion/normalized.ts)               |
| Shared finding/evaluator persistence                       | [`apps/worker/src/ingestion/program.ts`](../apps/worker/src/ingestion/program.ts)                     |

Run with private provider configuration and a local migrated database:

```sh
pnpm exec tsx --env-file=apps/worker/.env tests/live/v4-liquidity.ts
pnpm exec tsx --env-file=apps/worker/.env tests/database/v4-liquidity.ts
pnpm exec vitest run tests/unit/v4-liquidity.test.ts
```

For V3, [Mint/Burn/Collect are distinct pool events](https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolEvents.sol). Burn is not interchangeable with a user's actual token collection, and neither alone establishes NFT LP ownership. A reliable liquidity-removal capability needs an explicit definition plus decoded amounts and defensible valuation; it is intentionally not synthesized from swap liquidity fields.

Adding an event source should require its adapter/decoder, normalization, capability registration and reference tests. The generic evaluator should remain unchanged. Adding a generic aggregation already benefits compatible normalized Uniswap events without modifying the adapter.

## Open-source and submission status

The repository has an MIT license. Tracked environment paths inspected in this milestone are example files; local `.env` credentials and `.scout` provider artifacts remain private/ignored. This is not a full git-history secret audit or a legal review of every dependency. Review repository history and dependency licenses before making a remote public; no remote visibility was changed.

[FEEDBACK.md](../FEEDBACK.md) records actual integration experience and distinguishes the older Trading API work from the monitoring proof. **No external Uniswap feedback form or hackathon submission was completed by Scout.**
