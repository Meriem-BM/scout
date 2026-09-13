# scout_weth_usdc

Typed Ethereum mainnet Uniswap v3 swaps for Scout's supported WETH/USDC pools.

The decoder composes ethereum-common's reusable event index with a trusted Swap decoder and parameterized direction selector. It retains transaction initiator, pool caller, recipient, signed pool deltas, and log identity. The Node sink performs timestamped independent oracle valuation and durable sliding-window detection. This package does not call a pool price a trustworthy USD price.

| Module                  | Kind           | Output         | Purpose                                                      |
| ----------------------- | -------------- | -------------- | ------------------------------------------------------------ |
| eth_common:index_events | imported index | Keys           | Skip irrelevant blocks using a shared provider index         |
| map_swaps               | map            | scout.v1.Swaps | Decode supported pool events and transaction context         |
| map_watch               | map            | scout.v1.Swaps | Select exact pools and input token from validated parameters |

Requires the pinned Rust toolchain, Substreams 1.22.0, and a Graph Market data-plane key for streaming. Protobuf generation uses a pinned vendored protoc binary during the trusted build.

```sh
cargo build --locked --release --target wasm32-unknown-unknown
substreams pack substreams.yaml -o scout.spkg
substreams run scout.spkg map_watch -s 23240000 -t +100 --final-blocks-only -o jsonl
```

The manifest has a stable initial-block floor for content-addressed package reuse. Each deployment's stream request supplies its own recent start block, with at most one hour of initial window backfill. Package publication is not pipeline deployment; a running Node consumer and persisted checkpoint are required.
