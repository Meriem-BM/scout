import Link from "next/link";

import { CapabilityCatalog } from "@/features/capabilities/catalog";
import { Flow } from "@/features/communication/flow";
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
            Scout turns natural-language monitoring requests into verified live
            Watches. It checks what blockchain data is available, builds the
            monitoring logic, and only activates when the Watch can actually
            run.
          </p>
          <div className="public-actions">
            <Link className={buttonClassName("primary")} href="/watches">
              Build a Watch
            </Link>
            <Link className={buttonClassName("quiet")} href="/capabilities">
              See what Scout can monitor →
            </Link>
          </div>
        </div>
        <IntentPreview />
      </section>
      <section className="story-section">
        <header className="story-copy">
          <h2>What can Scout watch today?</h2>
          <p>
            Start with an available data source. Scout checks the exact chain,
            activity and conditions before building your Watch.
          </p>
        </header>
        <CapabilityCatalog compact />
      </section>
      <section className="story-section">
        <header className="story-copy">
          <h2>Your request. Checked before it goes live.</h2>
          <p>
            Scout understands what you want to watch, checks whether the
            required data is available, builds the monitoring logic, verifies
            it, and only then activates the Watch.
          </p>
        </header>
        <Flow
          label="From your request to a Watch"
          steps={[
            "Describe it",
            "Check data and tools",
            "Ask if something is missing",
            "Build and verify",
            "Monitor live",
          ]}
        />
      </section>
      <section className="story-section">
        <header className="story-copy">
          <h2>Mix conditions to describe what matters.</h2>
          <p>
            A request can combine an activity, a direction, an amount, a time
            window and wallet history. Scout checks each part, then checks
            whether the whole combination can run.
          </p>
        </header>
        <Flow
          label="How conditions combine"
          steps={[
            "Onchain activity",
            "+ Your filters",
            "+ Time or history",
            "A Watch, when verified",
          ]}
        />
        <p className="support-note">
          Some combinations are still being built. Scout explains the missing
          part and keeps your request unchanged.
        </p>
        <Link href="/docs/capabilities">Explore the monitoring tools →</Link>
      </section>
      <section className="story-section">
        <header className="story-copy">
          <h2>
            Protocols provide data.
            <br />
            Scout provides the monitoring logic.
          </h2>
          <p>
            Scout is not built as one monitor per protocol. New protocols can be
            added as data sources without rebuilding the Watch system.
          </p>
        </header>
        <Flow
          label="How Scout grows"
          steps={[
            "Installed data sources",
            "Scout monitoring engine",
            "Your Watches",
          ]}
        />
        <p className="support-note">
          More data sources can be added through Scout adapters. A protocol is
          only available when it appears in Scout’s capability list.
        </p>
      </section>
      <footer className="landing-footer" aria-label="Scout">
        <a className="landing-footer-name" href="#top">
          Scout
        </a>
        <nav aria-label="Explore Scout">
          <Link href="/capabilities">Capabilities</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/watches">Launch app</Link>
        </nav>
        <span>© 2026 Scout</span>
      </footer>
    </div>
  );
}
