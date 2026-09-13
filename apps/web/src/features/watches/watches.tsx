"use client";

import { useQuery } from "@tanstack/react-query";
import { Search as MagnifyingGlassIcon, Plus as PlusIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { z } from "zod";

import { CollectionWatchSchema, EXAMPLES, watchHealth } from "@scout/domain";
import { queryKeys } from "@/lib/query/keys";

import { api } from "../workspace/api";
import { useClock } from "../workspace/clock";
import { buttonClassName } from "../workspace/primitives";
import { Select } from "../workspace/select";
import { WatchesSkeleton } from "../workspace/skeletons";
import { ErrorNotice } from "../workspace/ui";
import { useWorkspace } from "../workspace/use-workspace";

import { WatchComposer } from "./composer";
import { setDraft } from "./draft";
import { WatchCard } from "./watch-card";

import type { Incident } from "@scout/domain";

export function Watches() {
  const { state, signedIn } = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const now = useClock();
  const filter = params.get("status") ?? "all";
  const sort = params.get("sort") ?? "newest";
  const search = params.get("q") ?? "";
  const page = Number(params.get("page") ?? 0) || 0;
  const [input, setInput] = useState(search);

  useEffect(() => {
    try {
      sessionStorage.setItem("scout.collection", `/watches?${params}`);
    } catch {
      /* Navigation still works without device storage. */
    }
  }, [params]);
  useEffect(() => {
    const key = "scout.collection.scroll";
    let position = 0;

    try {
      position = Number(sessionStorage.getItem(key) ?? 0);
    } catch {
      /* Defaults to top. */
    }

    const frame = requestAnimationFrame(() =>
      window.scrollTo({ top: position, behavior: "instant" }),
    );

    const remember = () => {
      try {
        sessionStorage.setItem(key, String(window.scrollY));
      } catch {
        /* Optional device state. */
      }
    };

    window.addEventListener("scroll", remember, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", remember);
    };
  }, []);

  const update = (values: Record<string, string>) => {
    const q = new URLSearchParams(params.toString());

    for (const [k, v] of Object.entries(values)) {
      if (v) {
        q.set(k, v);
      } else {
        q.delete(k);
      }
    }

    router.replace(`/watches?${q}`, { scroll: false });
  };

  useEffect(() => {
    if (input === search) {
      return;
    }

    const t = setTimeout(() => {
      const q = new URLSearchParams(params.toString());

      if (input) {
        q.set("q", input);
      } else {
        q.delete("q");
      }

      q.delete("page");
      router.replace(`/watches?${q}`, { scroll: false });
    }, 250);

    return () => clearTimeout(t);
  }, [input, search, params, router]);

  const collection = useQuery({
    queryKey: queryKeys.collection(filter, sort, search, page),
    queryFn: () =>
      api(
        `/api/watches?offset=${page * 20}&q=${encodeURIComponent(search)}&status=${filter === "attention" ? "all" : filter}&sort=${sort}`,
        z.array(CollectionWatchSchema),
      ),
    enabled: signedIn,
    placeholderData: (previous) => previous,
    refetchInterval: 10_000,
  });
  let watches = signedIn
    ? [...(collection.data ?? state.watches)]
    : state.watches;

  watches = watches.filter(
    (w) =>
      w.name.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "archived"
        ? w.status === "archived"
        : filter === "all"
          ? w.status !== "archived"
          : filter === "watching"
            ? ["watching", "live", "delayed"].includes(w.status)
            : filter === "attention"
              ? w.status !== "archived" &&
                watchHealth(w, state, now).needsAttention
              : w.status === filter),
  );
  watches.sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "oldest"
        ? a.createdAt.localeCompare(b.createdAt)
        : b.createdAt.localeCompare(a.createdAt),
  );

  const more = (collection.data?.length ?? 0) > 20;
  const shown = watches.slice(0, 20);

  return (
    <>
      <WatchComposer />
      <section
        className="watch-collection"
        aria-labelledby="collection-heading"
      >
        <div className="collection-heading">
          <h2 id="collection-heading">Your watches</h2>
          <span>Autonomous onchain monitoring</span>
        </div>
        <div className="collection-toolbar">
          <div className="filter-tabs" aria-label="Filter watches">
            {[
              ["all", "All"],
              ["watching", "Active"],
              ["paused", "Paused"],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => update({ status: value!, page: "" })}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="collection-search">
            <span className="sr-only">Search watches</span>
            <MagnifyingGlassIcon />
            <input
              placeholder="Search watches"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          <Select
            className="sort-select"
            aria-label="Sort watches"
            value={sort}
            onValueChange={(value) => update({ sort: value, page: "" })}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name A–Z</option>
          </Select>
          <button
            className={buttonClassName("quiet")}
            aria-pressed={filter === "archived"}
            onClick={() =>
              update({
                status: filter === "archived" ? "all" : "archived",
                page: "",
              })
            }
          >
            Archived
          </button>
        </div>
        <ErrorNotice message={collection.error?.message} />
        {collection.isLoading && !shown.length ? (
          <WatchesSkeleton />
        ) : shown.length ? (
          <div className="watch-grid">
            {shown.map((w) => (
              <WatchCard
                key={w.id}
                watch={w}
                recentIncidents={
                  "recentIncidents" in w
                    ? (w.recentIncidents as Incident[])
                    : undefined
                }
              />
            ))}
          </div>
        ) : (
          <div className="empty-collection">
            <div className="empty-collection-copy">
              <h2>
                {search || filter !== "all"
                  ? "No watches match this view"
                  : "No Watches yet."}
              </h2>
              <p>
                {search || filter !== "all"
                  ? "Try another search or status. Archived watches keep their history."
                  : "Describe something you care about onchain. Scout will resolve the data pipeline and verify it before monitoring begins."}
              </p>
            </div>
            {!search && filter === "all" && (
              <div className="empty-collection-actions">
                <button
                  className={buttonClassName("primary")}
                  onClick={() => {
                    setDraft(EXAMPLES[0]!);
                    document.getElementById("watch-prompt")?.focus();
                  }}
                >
                  <PlusIcon className="size-4" />
                  Start a watch
                </button>
              </div>
            )}
          </div>
        )}
        {(page > 0 || more) && (
          <div className="pagination">
            <button
              className={buttonClassName()}
              disabled={!page}
              onClick={() => update({ page: String(page - 1) })}
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              className={buttonClassName()}
              disabled={!more}
              onClick={() => update({ page: String(page + 1) })}
            >
              Next
            </button>
          </div>
        )}
      </section>
    </>
  );
}
