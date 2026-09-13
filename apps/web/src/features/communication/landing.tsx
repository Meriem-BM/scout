import Link from "next/link";

import { Flow, GraphArchitecture } from "@/features/communication/flow";
import { IntentPreview } from "@/features/communication/intent-preview";
import { buttonClassName } from "@/features/workspace/primitives";

export function LandingScreen() {
  return (
    <div className="public-story" id="top">
      <section className="public-hero">
        <div className="public-hero-copy">
          <h1>
            Tell Scout what <em>matters onchain.</em>
          </h1>
          <p>
            Scout turns monitoring intent into verified onchain infrastructure.
            Describe the signal; Scout resolves the data pipeline, tests it on
            real history, and keeps monitoring the live chain.
          </p>
          <div className="public-actions">
            <Link className={buttonClassName("primary")} href="/watches">
              Build a Watch
            </Link>
            <Link
              className={buttonClassName("quiet")}
              href="/docs/how-it-works"
            >
              See how it works →
            </Link>
          </div>
        </div>
        <IntentPreview />
        <p className="support-note hero-scope">
          Live today: verified Uniswap V3 ETH/USDC monitoring on Ethereum. Other
          intents use the same planning flow and stop safely when execution is
          not yet supported.
        </p>
      </section>
      <section className="story-section story-question" id="how-it-works">
        <h2>Onchain monitoring shouldn’t start with infrastructure.</h2>
        <p>
          Every new signal normally means finding contracts, decoding events,
          building indexers, backfilling history, and maintaining another
          service. Scout starts with what you want to know.
        </p>
      </section>
      <section className="story-section">
        <h2>History first. Live immediately after.</h2>
        <p>
          Substreams can process historical block ranges in parallel, then
          continue into a live stream. Scout uses historical execution to test
          its pipeline before activation and a durable cursor to continue toward
          chain head.
        </p>
        <figure className="parallel-explanation">
          <figcaption>
            How Substreams processes history · conceptual view
          </figcaption>
          <div className="parallel-ranges">
            {["Range A", "Range B", "Range C", "Range D"].map((range) => (
              <span key={range}>
                <span>{range}</span>
                <i aria-hidden="true">
                  <b />
                  <b />
                  <b />
                  <b />
                  <b />
                </i>
              </span>
            ))}
          </div>
          <p>Historical ranges processed in parallel</p>
          <Flow
            label="History to live stream"
            steps={[
              "Historical output",
              "Catch up to chain head",
              "Live blocks",
            ]}
          />
        </figure>
        <p className="support-note">
          Parallel execution is a Substreams capability. Scout shows measured
          progress only when the provider supplies it; historical testing is not
          proof of a complete wallet-history baseline.
        </p>
      </section>
      <section className="story-section">
        <h2>One prompt. The right pipeline.</h2>
        <p>
          Scout first checks whether someone has already built the data pipeline
          it needs. It inspects packages, plans reuse or composition, tests the
          executable pipeline against real blocks, and blocks activation if
          verification fails.
        </p>
        <div className="strategy-collection">
          {[
            [
              "Reuse",
              "Start with what exists.",
              "Scout checks existing packages before adding code.",
            ],
            [
              "Compose",
              "Fill the missing pieces.",
              "Connect useful outputs with only the normalization needed.",
            ],
            [
              "Verify",
              "Make correctness the gate.",
              "Compare pipeline output with independent chain history.",
            ],
          ].map(([name, title, description], index) => (
            <article key={name}>
              <span className="strategy-order" aria-hidden="true">
                0{index + 1}
              </span>
              <h3>{name}</h3>
              <p>
                <strong>{title}</strong>
                {description}
              </p>
            </article>
          ))}
        </div>
      </section>
      <section className="story-section">
        <h2>Why The Graph is load-bearing</h2>
        <p>
          Substreams supplies the historical and live blockchain pipeline.
          Subgraph queries provide wallet and pool context after a qualifying
          event. Scout compares evidence with your conditions and decides
          whether to alert or suppress.
        </p>
        <GraphArchitecture />
      </section>
      <footer className="landing-footer" aria-label="Scout">
        <a
          className="landing-footer-name"
          href="#top"
          aria-label="Scout, back to top"
        >
          Scout
        </a>
        <nav aria-label="Explore Scout">
          <Link href="/docs/how-it-works">How it works</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/watches">Launch app</Link>
        </nav>
        <span>© 2026 Scout</span>
      </footer>
    </div>
  );
}
