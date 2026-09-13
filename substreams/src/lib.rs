// Substreams macros emit safe exported WASM ABI wrappers around raw pointers.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

use substreams::{errors::Error, Hex};
use substreams_ethereum::{pb::eth::v2 as eth, Event};
pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/scout.v1.rs"));
}
// The ABI generator owns this module; keep its output unchanged across builds.
#[allow(
    clippy::redundant_static_lifetimes,
    clippy::needless_return,
    clippy::get_first,
    clippy::unnecessary_cast
)]
mod pool {
    include!(concat!(env!("OUT_DIR"), "/pool.rs"));
}

const POOLS: [&str; 2] = [
    "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
];
const WETH: &str = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", Hex::encode(bytes))
}

pub fn decode(block: &eth::Block) -> Result<pb::Swaps, Error> {
    let mut swaps = Vec::new();
    for tx in block.transactions() {
        for (log, _) in tx.logs_with_calls() {
            let address = hex0x(&log.address);
            if !POOLS.contains(&address.as_str()) {
                continue;
            }
            if let Some(event) = pool::events::Swap::match_and_decode(log) {
                swaps.push(pb::Swap {
                    pool: address,
                    transaction_hash: hex0x(&tx.hash),
                    log_index: log.block_index,
                    initiator: hex0x(&tx.from),
                    transaction_to: hex0x(&tx.to),
                    pool_caller: hex0x(&event.sender),
                    recipient: hex0x(&event.recipient),
                    amount0: event.amount0.to_string(),
                    amount1: event.amount1.to_string(),
                    sqrt_price_x96: event.sqrt_price_x96.to_string(),
                    liquidity: event.liquidity.to_string(),
                    tick: event.tick.to_string(),
                });
            }
        }
    }
    Ok(pb::Swaps { swaps })
}

#[substreams::handlers::map]
pub fn map_swaps(block: eth::Block) -> Result<pb::Swaps, Error> {
    decode(&block)
}

pub fn select(params: &str, input: pb::Swaps) -> Result<pb::Swaps, Error> {
    let (pool_list, sell) = params
        .split_once(';')
        .ok_or_else(|| Error::msg("Expected pool-list;sell-token"))?;
    let pools: Vec<&str> = pool_list.split(',').collect();
    if pools.is_empty()
        || pools.len() > 2
        || pools.iter().any(|p| !POOLS.contains(p))
        || ![WETH, USDC, "*"].contains(&sell)
    {
        return Err(Error::msg("Unsupported pipeline scope"));
    }
    let swaps = input
        .swaps
        .into_iter()
        .filter(|swap| {
            if sell == "*" {
                return pools.contains(&swap.pool.as_str())
                    && swap.amount0 != "0"
                    && swap.amount1 != "0"
                    && swap.amount0.starts_with('-') != swap.amount1.starts_with('-');
            }
            let (sold, bought) = if sell == WETH {
                (&swap.amount1, &swap.amount0)
            } else {
                (&swap.amount0, &swap.amount1)
            };
            pools.contains(&swap.pool.as_str())
                && !sold.starts_with('-')
                && sold != "0"
                && bought.starts_with('-')
        })
        .collect();
    Ok(pb::Swaps { swaps })
}

#[substreams::handlers::map]
pub fn map_watch(params: String, swaps: pb::Swaps) -> Result<pb::Swaps, Error> {
    select(&params, swaps)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_block_is_empty() {
        assert!(decode(&eth::Block::default()).unwrap().swaps.is_empty());
    }
    #[test]
    fn direction_and_pool_are_explicit() {
        let swap = pb::Swap {
            pool: POOLS[0].into(),
            amount0: "-50000000000".into(),
            amount1: "15000000000000000000".into(),
            ..Default::default()
        };
        assert_eq!(
            select(
                &format!("{};{}", POOLS[0], WETH),
                pb::Swaps {
                    swaps: vec![swap.clone()]
                }
            )
            .unwrap()
            .swaps
            .len(),
            1
        );
        assert!(select(
            &format!("{};{}", POOLS[0], USDC),
            pb::Swaps { swaps: vec![swap] }
        )
        .unwrap()
        .swaps
        .is_empty());
    }
    #[test]
    fn rejects_arbitrary_parameters() {
        assert!(select("../../tmp;$(whoami)", pb::Swaps::default()).is_err());
    }
    #[test]
    fn either_direction_preserves_both_sides_and_rejects_invalid_scope() {
        let input = pb::Swaps {
            swaps: vec![
                pb::Swap {
                    pool: POOLS[0].into(),
                    amount0: "100".into(),
                    amount1: "-1".into(),
                    ..Default::default()
                },
                pb::Swap {
                    pool: POOLS[0].into(),
                    amount0: "-100".into(),
                    amount1: "1".into(),
                    ..Default::default()
                },
                pb::Swap {
                    pool: POOLS[1].into(),
                    amount0: "100".into(),
                    amount1: "-1".into(),
                    ..Default::default()
                },
                pb::Swap {
                    pool: POOLS[0].into(),
                    amount0: "0".into(),
                    amount1: "-1".into(),
                    ..Default::default()
                },
            ],
        };
        let output = select(&format!("{};*", POOLS[0]), input).unwrap();
        assert_eq!(output.swaps.len(), 2);
        assert_eq!(output.swaps[0].amount0, "100");
        assert_eq!(output.swaps[1].amount0, "-100");
    }
    #[test]
    fn signed_abi_amounts_are_preserved() {
        let mut data = vec![0xff; 32];
        data.extend_from_slice(&[0; 31]);
        data.push(9);
        data.extend_from_slice(&[0; 96]);
        let mut sender = vec![0; 32];
        sender[31] = 1;
        let log = eth::Log {
            topics: vec![
                hex::decode("c42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67")
                    .unwrap(),
                sender.clone(),
                sender,
            ],
            data,
            ..Default::default()
        };
        let decoded = pool::events::Swap::match_and_decode(&log).unwrap();
        assert_eq!(decoded.amount0.to_string(), "-1");
        assert_eq!(decoded.amount1.to_string(), "9");
    }
    #[test]
    fn only_committed_logs_use_global_block_order() {
        let mut data = vec![0xff; 32];
        data.extend_from_slice(&[0; 31]);
        data.push(9);
        data.extend_from_slice(&[0; 96]);
        let log = eth::Log {
            address: hex::decode(&POOLS[0][2..]).unwrap(),
            index: 0,
            block_index: 42,
            topics: vec![
                hex::decode("c42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67")
                    .unwrap(),
                vec![0; 32],
                vec![0; 32],
            ],
            data,
            ..Default::default()
        };
        let block = eth::Block {
            transaction_traces: vec![
                eth::TransactionTrace {
                    status: 1,
                    calls: vec![
                        eth::Call {
                            logs: vec![log.clone()],
                            ..Default::default()
                        },
                        eth::Call {
                            state_reverted: true,
                            logs: vec![log.clone()],
                            ..Default::default()
                        },
                    ],
                    ..Default::default()
                },
                eth::TransactionTrace {
                    status: 2,
                    calls: vec![eth::Call {
                        logs: vec![log],
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let result = decode(&block).unwrap();
        assert_eq!(result.swaps.len(), 1);
        assert_eq!(result.swaps[0].log_index, 42);
    }
}
