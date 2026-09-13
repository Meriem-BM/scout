import Image from "next/image";

import { ScoutMark } from "@/features/workspace/scout-mark";

const stages = [
  "Describe the signal",
  "Resolve the pipeline",
  "Verify on history",
  "Monitor live",
];

export function IntentPreview() {
  return (
    <figure
      className="landing-intent"
      aria-label="Illustrative Scout product preview"
    >
      <div className="preview-wallpaper">
        <Image
          src="/brands/scout-mountain-hero.jpg"
          alt=""
          fill
          sizes="(max-width: 700px) 100vw, 960px"
          className="preview-wallpaper-image"
        />
        <div className="preview-workspace">
          <div className="preview-conversation">
            <span className="preview-brand">
              <ScoutMark />
              Scout
            </span>
            <p className="preview-message">
              Watch Uniswap V3 ETH/USDC buys above $100K from wallets that
              haven’t traded on Uniswap before.
            </p>
            <p className="preview-reply">
              Start with the signal. Scout works out the data, the pipeline, and
              the checks it needs.
            </p>
            <div className="preview-input" aria-hidden="true">
              Describe what matters…<span>↑</span>
            </div>
          </div>
          <div className="preview-plan">
            <div className="preview-plan-heading">
              <span>Your monitoring plan</span>
              <span>Example</span>
            </div>
            <h3>
              Large ETH buys.
              <br />
              With wallet context.
            </h3>
            <dl className="preview-definition">
              <div>
                <dt>Network</dt>
                <dd>Ethereum</dd>
              </div>
              <div>
                <dt>Protocol</dt>
                <dd>Uniswap V3</dd>
              </div>
              <div>
                <dt>Signal</dt>
                <dd>ETH / USDC · above $100K</dd>
              </div>
            </dl>
            <div className="preview-responsibility">
              <span>01</span>
              <div>
                <h4>Find the data pipeline</h4>
                <p>Search Substreams. Reuse what fits.</p>
              </div>
            </div>
            <div className="preview-responsibility">
              <span>02</span>
              <div>
                <h4>Check it against history</h4>
                <p>Compare real events before activation.</p>
              </div>
            </div>
            <div className="preview-responsibility">
              <span>03</span>
              <div>
                <h4>Keep the context</h4>
                <p>Investigate previous wallet activity.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="preview-caption">
        A question becomes a monitoring plan. Scout resolves the pipeline,
        verifies the data, and investigates the events that match.
        <span>
          Illustrative preview · monitoring starts only after verification.
        </span>
      </figcaption>
      <ol className="preview-stage-labels" aria-label="Monitoring lifecycle">
        {stages.map((stage, index) => (
          <li key={stage}>
            <span>{index + 1}</span>
            {stage}
          </li>
        ))}
      </ol>
    </figure>
  );
}
