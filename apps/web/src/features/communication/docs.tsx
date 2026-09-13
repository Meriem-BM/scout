import Link from "next/link";

import { CapabilityCatalog } from "../capabilities/catalog";

import { Flow } from "./flow";

const pages = {
  overview: {
    title: "Scout in 60 seconds",
    intro:
      "Describe what matters onchain. Scout checks whether it can monitor it, and tells you if anything is missing.",
    sections: [
      [
        "1. Describe what you want watched",
        "Write the activity and conditions you care about in your own words.",
      ],
      [
        "2. Scout understands the request",
        "Scout separates the activity, chain, tokens, wallets and conditions. Understanding a request does not mean it can run yet.",
      ],
      [
        "3. Scout checks what it needs",
        "It checks which blockchain data and monitoring tools are needed, using its current capability registry.",
      ],
      [
        "4. If information is missing, Scout asks",
        "A useful question helps confirm your intended scope. Scout keeps your requested conditions intact.",
      ],
      [
        "5. If a capability is unavailable, Scout tells you",
        "You can see what is available and exactly which part is missing. The Watch stays inactive.",
      ],
      [
        "6. Scout builds and verifies the Watch",
        "When the required capabilities are available, Scout prepares the data and tests the monitoring rules. A plan alone cannot activate a Watch.",
      ],
      [
        "7. Once ready, Scout monitors live activity",
        "Scout follows finalized chain activity and records matches. Your configured delivery settings determine where alerts are sent.",
      ],
    ],
  },
  capabilities: {
    title: "What is a capability?",
    intro: "A capability is something Scout knows how to observe or evaluate.",
    sections: [
      [
        "Data capabilities",
        "These provide blockchain activity, such as reading a protocol’s swaps. Support can differ between protocol versions and chains.",
      ],
      [
        "Monitoring capabilities",
        "These evaluate conditions, such as counting unique wallets in 10 minutes. A monitoring tool also needs compatible data and verification of the full Watch.",
      ],
      [
        "Historical capabilities",
        "These check earlier blockchain activity, such as whether a wallet used a protocol before. Unknown history is never treated as proof that no activity happened.",
      ],
      [
        "What the labels mean",
        "Ready means tested against real chain data. Available means the data or tool is installed but each Watch still needs verification. Limited means only part of the capability works. Not available yet means Scout cannot currently provide it.",
      ],
      [
        "Different versions, different activity",
        "Uniswap currently has Scout’s deepest protocol support. V3 and V4 appear separately because they expose different activity. Use the live list below to see the exact scope and limitations. ERC-20 transfer support is also listed by chain and token.",
      ],
    ],
  },
  works: {
    title: "From your request to a live Watch",
    intro:
      "Scout finds the data and checks the conditions behind your request before it starts monitoring.",
    sections: [
      [
        "Understand your request",
        "Scout identifies what you want to watch. If the token, chain or scope is unclear, it asks for the detail it needs.",
      ],
      [
        "Check data and monitoring tools",
        "Scout checks every condition against its installed capabilities. If something is missing, it explains that part before attempting to build.",
      ],
      [
        "Find and reuse blockchain data",
        "Scout looks for existing data pipelines it can reuse. Finding a package is only a starting point; its data must satisfy the request.",
      ],
      [
        "Verify the data and create the rules",
        "Scout checks real blockchain output and tests whether the Watch preserves your conditions. Failed or incomplete verification blocks activation.",
      ],
      [
        "Monitor and explain matches",
        "Once the stream is healthy and the Watch is verified, Scout monitors live activity. Matches retain their evidence, historical context and delivery status.",
      ],
    ],
  },
  substreams: {
    title: "What does Substreams do for Scout?",
    intro:
      "Substreams gives Scout fast access to structured blockchain activity. Scout can reuse existing Substreams packages instead of writing a new indexer for every Watch.",
    sections: [
      [
        "Historical processing",
        "Substreams can process historical block ranges in parallel. Scout uses earlier activity to test the data before activation. Testing a range does not prove complete wallet history.",
      ],
      [
        "Live streaming",
        "The same data pipeline can continue toward new finalized blocks. Scout saves its position so monitoring can recover after an interruption.",
      ],
      [
        "Reusable packages",
        "A package describes reusable blockchain data processing. Scout checks whether its output provides the activity and fields your Watch needs.",
      ],
      [
        "Why Scout verifies it",
        "A package name cannot prove that its data is correct for your request. Scout checks output against independent evidence and keeps a Watch inactive if verification fails.",
      ],
      [
        "Scout supplies the monitoring logic",
        "Substreams supplies activity. Scout applies your conditions, checks relevant history, records findings and delivers alerts.",
      ],
    ],
  },
  architecture: {
    title: "How Scout fits together",
    intro: "Protocols provide data. Scout provides the monitoring language.",
    sections: [
      [
        "Your request",
        "You describe the activity and conditions. Scout identifies the data and tools needed and asks about missing details.",
      ],
      [
        "Data sources",
        "Adapters turn protocol-specific activity into a consistent form Scout can evaluate. The capability registry records what each source provides and its limitations.",
      ],
      [
        "Monitoring rules",
        "Scout combines reusable conditions over that activity. It checks compatibility and verifies the whole Watch before activation.",
      ],
      [
        "A live Watch",
        "The worker follows finalized activity, checks the rules, investigates matches and delivers alerts according to your settings.",
      ],
      [
        "Adding protocols",
        "A new protocol adapter supplies data to the same monitoring engine. It does not require a separate Watch system. New sources must establish their capabilities before they are offered as supported.",
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
          ["/docs/capabilities", "Capabilities", "capabilities"],
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
        {page !== "overview" && page !== "capabilities" && (
          <Flow
            label="How Scout works"
            steps={[
              "Your request",
              "Scout understands it",
              "Data source",
              "Monitoring rules",
              "Verified live Watch",
            ]}
          />
        )}
        {content.sections.map(([title, body]) => (
          <section key={title}>
            <h2>{title}</h2>
            <p>{body}</p>
          </section>
        ))}
        <section>
          <h2>What Scout can monitor now</h2>
          <CapabilityCatalog compact={page !== "capabilities"} />
        </section>
        <details className="docs-advanced">
          <summary>Technical details</summary>
          <p>
            Internally, Scout represents the request as a typed WatchProgram and
            validates every required capability before activation. The
            Capability Planner separates data acquisition from the generic
            runtime. Availability is not proof of whole-program acceptance or
            live stream health.
          </p>
          <Flow
            label="Advanced architecture"
            steps={[
              "Intent Resolver",
              "WatchProgram",
              "Capability Planner",
              "Data Adapter / Substreams",
              "Normalized Events",
              "Generic Runtime",
              "Investigation",
              "Decision",
              "Delivery",
            ]}
          />
          <p>
            Watch details retain the capability plan, selected packages,
            modules, pipeline strategy, verification and historical evidence.
            General arbitrary pipeline generation is not currently implemented.
          </p>
          {page === "substreams" && (
            <p>
              Packages may include protobuf output types and compiled WASM
              modules. Scout inspects those artifacts and verifies field
              semantics before trusting their output.
            </p>
          )}
        </details>
        <Link href="/watches">Build a Watch →</Link>
      </article>
    </div>
  );
}
