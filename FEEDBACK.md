# Uniswap developer feedback

**Last updated: September 13, 2026.**

This feedback reflects two parts of Scout's Uniswap integration:

1. implementation/test-driving of the current official Trading API/OpenAPI flow for classic routing, and
2. real Uniswap V3 monitoring through Scout's Substreams-based monitoring pipeline.

No credential-backed Trading API quote or mainnet swap has been executed in this environment, so the Trading API notes below are implementation observations rather than claims about live API uptime, liquidity, or successful execution. The monitoring notes are based on real finalized-chain data and are called out separately.

## What helped

The agent-readable documentation index and downloadable OpenAPI schema made it practical to verify concrete request fields and routing shapes. Separating quote, approval checking, and swap preparation also fits a product where a user investigates an event before choosing whether to trade. The supported-chain/router table gave us an explicit allowlist instead of guessing deployment addresses.

On the monitoring side, Uniswap's event model is structured enough to normalize into a reusable monitoring runtime, while still exposing the protocol-specific semantics Scout needs for swaps, actors, pools, token flows, and historical activity checks.

## Friction and useful improvements

1. **Classic and order execution need an obvious boundary.** A compact official example that requests v3 classic execution, rejects every non-classic routing discriminator, and shows the different order path would reduce accidental misuse. Scout explicitly rejects UniswapX/order results before calldata preparation.
2. **Approval scope should be demonstrated end to end.** Examples showing exact ERC-20 allowance, `permitAmount: EXACT`, short Permit2 expiry, signer validation, and when a fresh quote is needed after an approval would be particularly useful. Scout validates the API spender, independently constructs exact-amount approval, and requotes afterward.
3. **A machine-readable reviewed-intent checklist would help.** Our integration validates chain, token contracts, input amount, recipient, routers/spenders, route pools, deadline, and minimum received, then decodes permitted Universal Router commands. An official reference validator covering output sent to the router and a final sweep would make this easier to audit.
4. **Unavailable metrics and quote freshness deserve a unified example.** We preserve missing price impact/gas USD as unavailable and use a conservative local thirty-second review lifetime. A documented UI contract explaining server quote freshness versus transaction deadline, optional metrics, and post-approval changes would reduce misleading reviews.
5. **A credential-free conformance fixture set would improve first-pass integration.** Signed-intent shapes for classic direct routes, split routes, required/no permit, rejected simulation, and unsupported routing would let developers test schemas without presenting fixtures as live API evidence. Scout's controlled tests are explicitly labeled and do not replace credential-gated checks.

## Monitoring adapter experience

Scout also uses Uniswap V3 as a first-class monitoring data source. In a real-provider test, Scout fetched finalized block `25,956,038` through its Substreams artifact, normalized the swap through its reusable adapter, and queried prior Uniswap activity through The Graph. The observed actor had prior activity, so the typed first-time-user predicate correctly suppressed the event. No trade or external alert was sent.

Useful integration lessons from building that path:

- **A pair is not one pool.** An authoritative, paginated pair-to-pool/fee-tier discovery example with completeness guarantees would help monitoring tools avoid claiming full market coverage from a small catalog.
- **Router/pool callers and transaction initiators have different meanings.** Examples that carry the transaction initiator alongside swap logs make actor-aware monitoring much easier to implement correctly.
- **Empty indexed history is not proof of no prior use.** Machine-readable coverage boundaries, deployment identity, and current-event exclusion examples would help developers present honest first-seen results.
- **Mint, Burn, and Collect need separate user-facing semantics.** A reference explaining when liquidity is changed versus tokens are actually withdrawn would help prevent misleading liquidity alerts.
- **V4's PoolManager and pool IDs need a separate acquisition contract.** A common normalized-event example across V3/V4 would help tooling reuse runtime logic without pretending their raw data layouts are interchangeable.

A real-seed test also exposed our own acceptance-generator assumption that the selected token would always be the first asset. We fixed that in Scout rather than attributing it to Uniswap.

## Integration code

- [Uniswap adapter and calldata validation](packages/integrations/src/uniswap.ts)
- [Shared quote/permit contracts](packages/domain/src/trade.ts)
- [Authenticated intent/quote endpoints](apps/web/src/app/api/trades/route.ts)
- [Embedded wallet review/signing flow](apps/web/src/features/trades/swap.tsx)
- [Receipt reconciliation](apps/worker/src/jobs/handlers.ts)
- [Controlled provider-contract tests](tests/integration/provider-contracts.test.ts)

References: [official swapping overview](https://developers.uniswap.org/docs/trading/swapping-api/getting-started), [supported chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains), [OpenAPI](https://trade-api.gateway.uniswap.org/v1/api.json), [documentation index](https://developers.uniswap.org/llms.txt).

## Required external step

The current ETHOnline requirements also call for the [official Uniswap Developer Feedback Form](https://developers.uniswap.org/hackathon-feedback) with a link to the public `FEEDBACK.md`.

**The form has not been submitted yet.** Publish the repository/feedback file first, then submit the form separately. If you run a credential-backed quote, swap, or additional live Uniswap monitoring test before submission, update this file with those genuine observations before submitting the form.

These are implementation observations, not claims about provider uptime or complete Uniswap market coverage.
