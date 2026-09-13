"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, Inbox, Radio, Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
  dialogContentClassName,
  dialogOverlayClassName,
  iconButtonClassName,
} from "@/features/workspace/primitives";

import { useWorkspace } from "./use-workspace";

export function WorkspaceSearch() {
  const { state } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const term = query.trim().toLowerCase();
  const watches = state.watches
    .filter(
      (watch) =>
        watch.status !== "archived" && watch.name.toLowerCase().includes(term),
    )
    .slice(0, 8);
  const incidents = state.incidents
    .filter((incident) => incident.title.toLowerCase().includes(term))
    .slice(0, 8);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);

        if (!next) {
          setQuery("");
        }
      }}
    >
      <Dialog.Trigger asChild>
        <button
          className="fixed top-3 right-3 z-30 flex size-10 items-center justify-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/70 text-sm text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white md:static md:my-3 md:h-10 md:w-full md:justify-start md:px-3 group-data-[collapsed=true]/shell:md:justify-center group-data-[collapsed=true]/shell:md:px-0 [&_kbd]:ml-auto [&_kbd]:rounded [&_kbd]:border [&_kbd]:border-neutral-700 [&_kbd]:px-1 [&_kbd]:font-sans [&_kbd]:text-[10px]"
          aria-label="Search workspace"
        >
          <Search width={15} height={15} />
          <span className="hidden md:inline group-data-[collapsed=true]/shell:md:hidden">
            Search
          </span>
          <kbd className="hidden md:inline group-data-[collapsed=true]/shell:md:hidden">
            ⌘ K
          </kbd>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={`${dialogContentClassName} overflow-hidden p-0!`}
        >
          <Dialog.Title className="sr-only">Search your workspace</Dialog.Title>
          <Dialog.Description className="sr-only">
            Find watches and incidents in your loaded workspace. Archived
            watches are excluded.
          </Dialog.Description>
          <div className="flex items-center gap-3 border-b border-neutral-800 p-3 [&>svg]:text-muted [&_input]:min-h-11 [&_input]:w-full [&_input]:min-w-0 [&_input]:bg-transparent [&_input]:text-base [&_input]:outline-none [&_input]:ring-0">
            <Search width={18} height={18} />
            <input
              aria-label="Search watches and incidents"
              placeholder="Search watches and incidents…"
              maxLength={100}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Dialog.Close
              className={iconButtonClassName}
              aria-label="Close search"
            >
              <X width={17} height={17} />
            </Dialog.Close>
          </div>
          <div className="max-h-[50dvh] overflow-y-auto p-2" aria-live="polite">
            {watches.length + incidents.length === 0 ? (
              <p className="px-6 py-12 text-center text-sm leading-6 text-muted">
                {term
                  ? "No matching watches or incidents."
                  : "Your saved watches and incidents will appear here."}
              </p>
            ) : (
              <>
                {watches.length > 0 && (
                  <p className="px-3 pt-4 pb-2 text-xs text-muted">Watches</p>
                )}
                {watches.map((watch) => (
                  <Dialog.Close asChild key={watch.id}>
                    <Link
                      href={`/new?edit=${watch.id}`}
                      className="flex min-h-12 items-center gap-3 rounded-md px-3 py-3 text-sm text-neutral-300 hover:bg-neutral-800 hover:text-white [&>span]:min-w-0 [&>span]:flex-1 [&>svg]:text-muted"
                    >
                      <Radio width={16} height={16} />
                      <span>{watch.name}</span>
                      <ArrowUpRight width={14} height={14} />
                    </Link>
                  </Dialog.Close>
                ))}
                {incidents.length > 0 && (
                  <p className="px-3 pt-4 pb-2 text-xs text-muted">Incidents</p>
                )}
                {incidents.map((incident) => (
                  <Dialog.Close asChild key={incident.id}>
                    <Link
                      href={`/watches/${incident.watchId}/incidents/${incident.id}`}
                      className="flex min-h-12 items-center gap-3 rounded-md px-3 py-3 text-sm text-neutral-300 hover:bg-neutral-800 hover:text-white [&>span]:min-w-0 [&>span]:flex-1 [&>svg]:text-muted"
                    >
                      <Inbox width={16} height={16} />
                      <span>{incident.title}</span>
                      <ArrowUpRight width={14} height={14} />
                    </Link>
                  </Dialog.Close>
                ))}
              </>
            )}
          </div>
          <div className="flex justify-between gap-4 border-t border-neutral-800 px-5 py-3 text-xs text-muted">
            <span>Current workspace only</span>
            <span>Esc to close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
