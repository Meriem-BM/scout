import { SketchArrow } from "@/components/ui/sketch-arrow";

export function Flow({ steps, label }: { steps: string[]; label: string }) {
  return (
    <ol className="narrative-flow" aria-label={label}>
      {steps.map((step, index) => (
        <li key={`${index}-${step}`}>
          <span>{step}</span>
          {index < steps.length - 1 && (
            <i aria-hidden="true">
              <SketchArrow />
            </i>
          )}
        </li>
      ))}
    </ol>
  );
}

export function GraphArchitecture() {
  return (
    <div className="graph-explanation">
      <div>
        <h3>Substreams</h3>
        <p>Historical blocks + live stream</p>
        <span>The data pipeline</span>
      </div>
      <div>
        <h3>Subgraph data</h3>
        <p>Wallet + pool history</p>
        <span>The investigation context</span>
      </div>
      <p className="graph-explanation-result">
        <span>Scout rules</span>
        <SketchArrow />
        <span>investigation</span>
        <SketchArrow />
        <span>alert or suppress</span>
      </p>
    </div>
  );
}
