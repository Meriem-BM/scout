"use client";

import { Close as DialogClose } from "@radix-ui/react-dialog";
import {
  Radio as Activity,
  ArrowUpRight,
  ChevronDown,
  CircleDollarSign,
  Database,
  Send,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";

import { buttonClassName } from "@/features/workspace/primitives";

import { Modal } from "./ui";
import { useWorkspace } from "./use-workspace";

export function TokenPair() {
  return (
    <span
      className="inline-flex shrink-0 items-center -space-x-2"
      aria-hidden="true"
    >
      <span className="flex size-8 items-center justify-center rounded-full border-2 border-neutral-950 bg-neutral-800 text-neutral-200">
        <svg
          width="16"
          height="20"
          viewBox="0 0 16 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 0 1 12l7 4 7-4L8 0Z" opacity=".65" />
          <path d="m8 0 7 12-7 4V0Z" />
          <path d="m1 14 7 10 7-10-7 4-7-4Z" opacity=".8" />
        </svg>
      </span>
      <span className="flex size-8 items-center justify-center rounded-full border-2 border-neutral-950 bg-blue-950 text-blue-200">
        <CircleDollarSign width={19} height={19} strokeWidth={1.5} />
      </span>
    </span>
  );
}

export function Sources({ trigger }: { trigger?: React.ReactNode } = {}) {
  const { state } = useWorkspace();
  const running = state.watches.filter(
    (watch) => watch.status === "watching",
  ).length;
  const enriched = state.incidents.filter(
    (incident) => incident.context && incident.context.status !== "unavailable",
  ).length;

  return (
    <Modal
      title="The sources behind Scout"
      description="Streaming detects the event. Graph adds context. Telegram takes the alert with you."
      trigger={
        trigger ?? (
          <button
            className="inline-flex min-h-10 items-center gap-2 rounded-md px-2 text-xs text-neutral-400 transition-colors hover:bg-white/5 hover:text-white [&>span:nth-child(2)]:hidden sm:[&>span:nth-child(2)]:inline max-sm:[&>svg]:size-5"
            aria-label="Sources and connection status"
          >
            <span
              className="hidden -space-x-1.5 items-center sm:inline-flex [&>span]:flex [&>span]:size-6 [&>span]:items-center [&>span]:justify-center [&>span]:rounded-full [&>span]:border-2 [&>span]:border-neutral-950 [&>span]:bg-neutral-800 [&>span]:text-neutral-400"
              aria-hidden="true"
            >
              <span>
                <Activity width={16} height={16} />
              </span>
              <span>
                <Database width={16} height={16} />
              </span>
              <span>
                <Send width={15} height={15} />
              </span>
            </span>
            <span>Sources</span>
            <Database className="size-5 sm:hidden" />
            <ChevronDown width={14} height={14} className="hidden sm:block" />
          </button>
        )
      }
    >
      <div className="divide-y divide-neutral-800">
        <div className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-5 sm:grid-cols-[40px_minmax(0,1fr)_auto] [&_h3]:text-sm [&_p]:mt-1 [&_p]:text-xs [&_p]:text-neutral-400">
          <span className="flex size-10 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-300">
            <Activity width={23} height={23} />
          </span>
          <div>
            <h3>Substreams</h3>
            <p>Finalized onchain events · live detection</p>
          </div>
          <span className="col-start-2 text-xs text-muted sm:col-start-auto">
            {running ? `${running} watching` : "Not watching"}
          </span>
        </div>
        <div className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-5 sm:grid-cols-[40px_minmax(0,1fr)_auto] [&_h3]:text-sm [&_p]:mt-1 [&_p]:text-xs [&_p]:text-neutral-400">
          <span className="flex size-10 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-300">
            <Database width={23} height={23} />
          </span>
          <div>
            <h3>The Graph</h3>
            <p>Bounded history · incident context</p>
          </div>
          <span className="col-start-2 text-xs text-muted sm:col-start-auto">
            {enriched ? `${enriched} enriched` : "No context yet"}
          </span>
        </div>
        <div className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-5 sm:grid-cols-[40px_minmax(0,1fr)_auto] [&_h3]:text-sm [&_p]:mt-1 [&_p]:text-xs [&_p]:text-neutral-400">
          <span className="flex size-10 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-300">
            <Send width={23} height={23} />
          </span>
          <div>
            <h3>Telegram</h3>
            <p>Private alerts · paired bot delivery</p>
          </div>
          <span className="col-start-2 text-xs text-muted sm:col-start-auto">
            {state.telegram.connected ? "Connected" : "Not connected"}
          </span>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 pt-4 text-xs text-muted">
        <span>Protocol-aware pipelines · verified before activation</span>
        <DialogClose asChild>
          <Link className={buttonClassName("quiet")} href="/connections">
            Delivery settings <ArrowUpRight width={14} height={14} />
          </Link>
        </DialogClose>
      </div>
    </Modal>
  );
}

export function ScopeNote() {
  return (
    <div className="scope-note">
      <div className="scope-note-primary">
        <span className="scope-note-icon">
          <Activity width={19} height={19} />
        </span>
        <div>
          <h3>Autonomous onchain monitoring</h3>
          <p>
            Describe the activity. Scout resolves the protocol, chain, data,
            pipeline, and verification plan.
          </p>
        </div>
      </div>
      <div className="scope-note-list">
        <div className="scope-note-row">
          <TokenPair />
          <div>
            <h3>Uniswap · first-class</h3>
            <p>Deepest planning, verification, Graph context, and live path.</p>
          </div>
        </div>
        <div className="scope-note-row">
          <span className="scope-note-secondary-icon">
            <Database width={16} height={16} />
          </span>
          <div>
            <h3>Other onchain intents</h3>
            <p>
              Planned through the same compiler and activated only after a real
              executor passes verification.
            </p>
          </div>
        </div>
      </div>
      <p className="scope-note-assurance">
        <ShieldCheck width={15} height={15} /> No Watch is marked live without
        real execution and semantic checks
      </p>
    </div>
  );
}
