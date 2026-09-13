import type { ReactNode } from "react";

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`scout-skeleton ${className}`} aria-hidden="true" />;
}

function LoadingRegion({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`loading-region ${className}`}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

function Lines() {
  return (
    <div className="skeleton-lines">
      <Skeleton className="skeleton-title" />
      <Skeleton />
      <Skeleton className="skeleton-short" />
    </div>
  );
}

export function WatchesSkeleton() {
  return (
    <LoadingRegion label="Loading Watches">
      <div className="watch-grid">
        {[0, 1, 2, 3].map((slot) => (
          <div className="skeleton-card" key={slot}>
            <div className="skeleton-heading">
              <Skeleton className="skeleton-avatar" />
              <Skeleton className="skeleton-short" />
            </div>
            <Lines />
            <Skeleton className="skeleton-panel" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

export function PipelineSkeleton() {
  return (
    <LoadingRegion
      label="Loading pipeline and verification"
      className="skeleton-pipeline"
    >
      <Lines />
      <div className="skeleton-facts">
        {[0, 1, 2].map((slot) => (
          <Skeleton key={slot} />
        ))}
      </div>
    </LoadingRegion>
  );
}

export function InvestigationSkeleton() {
  return (
    <LoadingRegion
      label="Loading investigation evidence"
      className="skeleton-investigation"
    >
      <Lines />
      <div className="skeleton-facts">
        {[0, 1, 2, 3].map((slot) => (
          <Skeleton key={slot} />
        ))}
      </div>
      <Skeleton className="skeleton-evidence" />
      <Lines />
    </LoadingRegion>
  );
}

export function WatchDetailSkeleton() {
  return (
    <LoadingRegion label="Loading Watch" className="skeleton-detail">
      <Skeleton className="skeleton-short" />
      <Lines />
      <div className="skeleton-detail-columns">
        <div className="skeleton-card">
          <Lines />
          <Skeleton className="skeleton-panel" />
        </div>
        <div className="skeleton-card">
          <Lines />
          <Skeleton className="skeleton-evidence" />
        </div>
      </div>
    </LoadingRegion>
  );
}

export function WorkflowSkeleton() {
  return (
    <LoadingRegion label="Loading saved workflow">
      <div className="workflow-layout">
        <div>
          {[0, 1, 2, 3].map((slot) => (
            <div className="skeleton-workflow-step" key={slot}>
              <Skeleton className="skeleton-avatar" />
              <Lines />
            </div>
          ))}
        </div>
        <div className="skeleton-card">
          <Lines />
          <Skeleton className="skeleton-panel" />
          <Lines />
        </div>
      </div>
    </LoadingRegion>
  );
}

export function ConnectionsSkeleton({ single = false }: { single?: boolean }) {
  return (
    <LoadingRegion label="Loading connection status">
      <div className="skeleton-connections">
        {(single ? [0] : [0, 1]).map((slot) => (
          <div className="skeleton-card" key={slot}>
            <div className="skeleton-heading">
              <Skeleton className="skeleton-avatar" />
              <Skeleton className="skeleton-short" />
            </div>
            <Lines />
            <Skeleton className="skeleton-panel" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

export function InvestigationListSkeleton() {
  return (
    <LoadingRegion label="Loading investigations">
      {[0, 1, 2].map((slot) => (
        <div className="incident-rail-row" key={slot}>
          <Lines />
        </div>
      ))}
    </LoadingRegion>
  );
}

export function EvidenceSceneSkeleton() {
  return (
    <LoadingRegion label="Loading transaction evidence">
      <Skeleton className="skeleton-evidence" />
    </LoadingRegion>
  );
}
