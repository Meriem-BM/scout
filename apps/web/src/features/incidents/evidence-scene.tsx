"use client";

import { ArrowUpRight as ArrowUpRightIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { decimal, tokenByAddress, usd } from "@scout/domain";

import { shortAddress, useDateTime } from "../workspace/formatting";

import type { Incident } from "@scout/domain";

export default function EvidenceScene({ incident }: { incident: Incident }) {
  const dateTime = useDateTime();
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const transactions = [
    ...new Set(incident.evidence.map((e) => e.transactionHash)),
  ]
    .map((hash) => ({
      hash,
      events: incident.evidence.filter((e) => e.transactionHash === hash),
    }))
    .sort((a, b) => a.events[0]!.timestamp - b.events[0]!.timestamp);
  const selected = Math.max(
    0,
    transactions.findIndex((t) => t.hash === params.get("tx")),
  );
  const transaction = transactions[selected];

  const choose = (index: number) => {
    const tx = transactions[index];

    if (!tx) {
      return;
    }

    const q = new URLSearchParams(params.toString());

    q.set("tx", tx.hash);
    router.replace(`${path}?${q}`, { scroll: false });
  };

  if (!transaction) {
    return (
      <p className="connection-note">
        Transaction evidence is not available yet. Scout has preserved the
        recorded conclusion.
      </p>
    );
  }

  const event = transaction.events[0]!;
  const value = (events: typeof transaction.events) =>
    events.every((e) => e.valuation)
      ? usd(
          events
            .reduce((sum, e) => sum + BigInt(e.valuation!.usdMicros), 0n)
            .toString(),
        )
      : "USD unavailable";

  return (
    <>
      <section
        className="transaction-workspace"
        aria-label="Transaction evidence"
      >
        <div className="transaction-section-heading">
          <div>
            <span className="eyebrow">Onchain evidence</span>
            <h3>What happened</h3>
          </div>
          <span>
            {transactions.length} transaction
            {transactions.length === 1 ? "" : "s"} in this excerpt
          </span>
        </div>
        <div className="transaction-ledger" aria-label="Select a transaction">
          {transactions.map((tx, index) => (
            <button
              key={tx.hash}
              className="transaction-ledger-row"
              aria-pressed={selected === index}
              onClick={() => choose(index)}
            >
              <span className="transaction-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>
                <strong>{shortAddress(tx.events[0]!.initiator)}</strong>
                <small>Transaction initiator</small>
              </span>
              <span>
                <strong>{value(tx.events)}</strong>
                <small>
                  {tx.events.length} pool event
                  {tx.events.length === 1 ? "" : "s"}
                </small>
              </span>
              <span>
                <time>{dateTime(tx.events[0]!.timestamp)}</time>
                <small>{shortAddress(tx.hash)}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="transaction-receipt" aria-live="polite">
          <div className="transaction-section-heading">
            <h3>Transaction {selected + 1}</h3>
            <a
              href={`https://etherscan.io/tx/${event.transactionHash}`}
              target="_blank"
              rel="noreferrer"
            >
              Open on Etherscan <ArrowUpRightIcon />
            </a>
          </div>
          {transaction.events.map((observation) => {
            const token = tokenByAddress(observation.sellToken);

            return (
              <div className="transaction-transfer" key={observation.id}>
                <div>
                  <span className="eyebrow">Sold into pool</span>
                  <strong>
                    {decimal(observation.sellAmount, token.decimals, 4)}{" "}
                    <span>{token.symbol}</span>
                  </strong>
                  <small>
                    {observation.valuation
                      ? usd(observation.valuation.usdMicros)
                      : "USD value unavailable"}
                  </small>
                </div>
                <span className="transfer-arrow" aria-hidden="true">
                  →
                </span>
                <div>
                  <span className="eyebrow">Observed pool</span>
                  <strong>{shortAddress(observation.pool)}</strong>
                  <small>Log {observation.logIndex} · Uniswap V3</small>
                </div>
              </div>
            );
          })}
          <dl className="transaction-facts">
            <div>
              <dt>Submitted by</dt>
              <dd title={event.initiator}>{shortAddress(event.initiator)}</dd>
            </div>
            <div>
              <dt>Block</dt>
              <dd>{Number(event.blockNumber).toLocaleString("en")}</dd>
            </div>
            <div>
              <dt>Included at</dt>
              <dd>{dateTime(event.timestamp)}</dd>
            </div>
          </dl>
          <p className="transaction-limit">
            The initiator submitted this transaction; it may not own the funds.
            Values describe the observed pool events, not the complete trading
            route.
          </p>
        </div>
      </section>
      <details className="mt-4">
        <summary className="text-sm text-neutral-300">
          All source events · {incident.evidence.length} pool events
        </summary>
        <div className="overflow-x-auto">
          <table className="evidence-table">
            <caption className="sr-only">
              The exact observations behind this incident
            </caption>
            <thead>
              <tr>
                <th scope="col">Transaction</th>
                <th scope="col">Initiator</th>
                <th scope="col">Amount sold</th>
                <th scope="col">Time</th>
                <th scope="col">Pool / log</th>
              </tr>
            </thead>
            <tbody>
              {incident.evidence.map((e) => (
                <tr key={e.id}>
                  <td>
                    <button
                      className="evidence-table-select"
                      onClick={() =>
                        choose(
                          transactions.findIndex(
                            (t) => t.hash === e.transactionHash,
                          ),
                        )
                      }
                    >
                      {shortAddress(e.transactionHash)}
                    </button>
                  </td>
                  <td>{shortAddress(e.initiator)}</td>
                  <td>
                    {decimal(
                      e.sellAmount,
                      tokenByAddress(e.sellToken).decimals,
                      5,
                    )}{" "}
                    {tokenByAddress(e.sellToken).symbol}
                  </td>
                  <td>{dateTime(e.timestamp)}</td>
                  <td>
                    {shortAddress(e.pool)} / {e.logIndex}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {incident.detection.evidenceIds.length > incident.evidence.length && (
        <p className="card-notice">
          This is a bounded excerpt of {incident.evidence.length} pool events.
          The recorded aggregate includes{" "}
          {incident.detection.evidenceIds.length} evidence identities.
        </p>
      )}
    </>
  );
}
