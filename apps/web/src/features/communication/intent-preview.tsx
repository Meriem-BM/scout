"use client";

import Image from "next/image";

import { useCapabilities } from "../capabilities/queries";
import { ProtocolMark } from "../workspace/protocol-mark";
import { ScoutMark } from "../workspace/scout-mark";

export function IntentPreview() {
  const capabilities = useCapabilities();
  const example = capabilities.data?.examples[0];
  const exampleProtocol = capabilities.data?.protocols.find(
    (entry) => entry.id === example?.adapterId,
  )?.protocol;

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
              <ProtocolMark protocol={exampleProtocol} size={18} />
              <span>{example?.label ?? "Describe what matters onchain."}</span>
            </p>
            <p className="preview-reply">
              Scout checks the data and monitoring tools this request needs
              before building the Watch.
            </p>
            <div className="preview-input" aria-hidden="true">
              Describe what matters…<span>↑</span>
            </div>
          </div>
          <div className="preview-plan">
            <div className="preview-plan-heading">
              <span>Your monitoring plan</span>
              <span>Illustration</span>
            </div>
            <h3>
              Understood.
              <br />
              Then checked.
            </h3>
            {[
              [
                "01",
                "Understand your request",
                "Keep the scope and conditions you asked for.",
              ],
              [
                "02",
                "Check what’s available",
                "Explain any missing data or monitoring tools.",
              ],
              [
                "03",
                "Verify before activation",
                "A plan becomes live only after it passes the checks.",
              ],
            ].map(([n, title, copy]) => (
              <div className="preview-responsibility" key={n}>
                <span>{n}</span>
                <div>
                  <h4>{title}</h4>
                  <p>{copy}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <figcaption>
        Illustrative flow · each Watch is checked against Scout’s current
        capabilities.
      </figcaption>
    </figure>
  );
}
