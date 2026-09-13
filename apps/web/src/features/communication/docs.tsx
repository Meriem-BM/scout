import Link from "next/link";

import { Flow, GraphArchitecture } from "./flow";

const pages = {
  overview: {
    title: "Scout in 60 seconds",
    intro:
      "Describe a monitoring question. Scout resolves the data and infrastructure, verifies the executable pipeline, and follows the chain for you.",
    sections: [
      [
        "Start with intent",
        "For example: Watch Uniswap V3 ETH/USDC buys above $100K from wallets that haven’t traded on Uniswap before. Scout resolves the network, pair, direction, threshold, and historical investigation requirement. It asks for clarification only when a missing answer changes the result.",
      ],
      [
        "More than an alert dashboard",
        "Scout plans the infrastructure behind the signal: it discovers Substreams packages, selects an architecture, and tests the resulting pipeline against independently retrieved chain history. Compilation alone never authorizes activation.",
      ],
      [
        "After detection",
        "Deterministic rules filter the stream first. Qualifying events receive historical Graph context and an evidence-based investigation. Alert delivery is separate from monitoring, with explicit email consent and Telegram pairing.",
      ],
    ],
  },
  works: {
    title: "From intent to verified infrastructure",
    intro:
      "Scout first checks whether someone has already built the data pipeline it needs.",
    sections: [
      [
        "Understand and clarify",
        "Natural language becomes a structured Watch intent with explicit fields, visible assumptions, and blocking questions. Your answer resumes the same persisted workflow.",
      ],
      [
        "Plan the data",
        "DataRequirementSpec separates streaming facts, deterministic rules, historical queries, investigation, and delivery. PipelinePlan records selected packages, modules, strategy, and verification requirements.",
      ],
      [
        "Reuse before generating",
        "REUSE consumes an existing output. PARAMETERIZE configures an existing module. COMPOSE connects reusable infrastructure with a small normalization module. GENERATE builds missing infrastructure when reuse cannot satisfy the request; general generation is not yet implemented in Scout.",
      ],
      [
        "Prove it before activation",
        "The implemented executor compiles a trusted module, runs it on historical Ethereum blocks, and compares output with independent Subgraph data. The durable consumer then catches up. Live activation requires actual finalized output within the configured head-lag tolerance.",
      ],
    ],
  },
  substreams: {
    title: "Why Scout uses Substreams",
    intro:
      "A monitor needs trustworthy history as well as the next block. Substreams connects those two needs.",
    sections: [
      [
        "Parallel history",
        "Substreams can distribute historical work across block ranges instead of processing the entire chain one block at a time. Execution depends on the package, dependencies, cache, and provider. Scout does not claim a speedup or number of parallel jobs without measurements.",
      ],
      [
        "Reuse blockchain knowledge",
        "The Substreams registry contains compiled packages with inspectable modules and output types. Scout searches and inspects them before choosing an architecture. Finding a familiar package name is not proof that its output satisfies your intent.",
      ],
      [
        "History into live data",
        "Scout tests an executable pipeline against a bounded historical range, then consumes finalized blocks using a persisted cursor. Catch-up status reports actual pipeline and network heads. The current implementation does not claim a complete pre-activation wallet-history baseline.",
      ],
      [
        "Context is a separate job",
        "After deterministic rules identify a candidate, Subgraph queries retrieve relevant history for investigation. Partial or failed context stays visible; it is never relabeled as complete just because the stream is live.",
      ],
      [
        "Inspect and reuse your package",
        "Open a Watch’s technical proof to view its selected registry dependency and download its private package, manifest, and sources. Registry publication is separate from deployment. Scout does not currently publish packages on your behalf.",
      ],
    ],
  },
  architecture: {
    title: "How Scout fits together",
    intro:
      "One durable workflow connects your intent to verified infrastructure and evidence-backed investigations.",
    sections: [
      [
        "Intent planner",
        "Converts your request into structured monitoring requirements and asks useful clarification questions. The model resolves intent; it does not decide whether a build or verification succeeded.",
      ],
      [
        "Package resolver and pipeline planner",
        "Search the real Substreams registry, inspect output types and dependencies, and persist the proposed architecture. Runtime compatibility and independent verification remain separate gates.",
      ],
      [
        "Build and verification",
        "The current trusted Uniswap executor compiles a real package and compares historical output with reference events. A generic untrusted-code sandbox and broader executors remain implementation work.",
      ],
      [
        "Durable stream and runtime",
        "The worker consumes finalized blockchain data independently of browser sessions. Cursors and canonical event identities protect recovery and duplicate processing; rules reduce the events sent for investigation.",
      ],
      [
        "Investigation and delivery",
        "The Graph supplies historical context. Scout records facts, interpretation, and limits, then queues an alert or suppresses it. Telegram and email delivery have their own states and consent requirements.",
      ],
    ],
  },
} as const;

export function DocsPage({ page }: { page: keyof typeof pages }) {
  const content = pages[page];

  return (
    <div className="docs-layout">
      <nav aria-label="Documentation">
        {[
          ["/docs", "Scout in 60 seconds", "overview"],
          ["/docs/how-it-works", "How it works", "works"],
          ["/docs/substreams", "Why Substreams", "substreams"],
          ["/docs/architecture", "Architecture", "architecture"],
        ].map(([href, label, key]) => (
          <Link
            key={href}
            href={href!}
            aria-current={key === page ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
      <article className="docs-article">
        <span className="eyebrow">Scout documentation</span>
        <h1>{content.title}</h1>
        <p className="docs-lead">{content.intro}</p>
        <Flow
          label="Monitoring architecture"
          steps={
            page === "architecture"
              ? [
                  "User intent",
                  "Intent planner",
                  "Package resolver → Registry",
                  "Pipeline planner",
                  "Verification",
                  "Substreams history + live",
                  "Scout rules",
                  "Graph context + investigation",
                  "Alert / suppress",
                ]
              : [
                  "Intent",
                  "Plan",
                  "Resolve data",
                  "Build or reuse",
                  "Verify",
                  "Deploy",
                  "Monitor",
                ]
          }
        />
        {content.sections.map(([title, body]) => (
          <section key={title}>
            <h2>{title}</h2>
            <p>{body}</p>
          </section>
        ))}
        {page === "architecture" && <GraphArchitecture />}
        <aside className="docs-scope">
          <strong>Current execution scope</strong>
          <p>
            Ethereum Uniswap V3 WETH/USDC is the verified live path. Other
            protocol intents can be planned but may stop before activation.
            Scout never labels an unsupported executor as live.
          </p>
        </aside>
        <p>
          <a
            href="https://thegraph.com/docs/en/substreams/public-substreams/substreams-dev/"
            target="_blank"
            rel="noreferrer"
          >
            The Graph: packages and historical/live data ↗
          </a>
        </p>
        <Link href="/watches">Build a Watch →</Link>
      </article>
    </div>
  );
}
