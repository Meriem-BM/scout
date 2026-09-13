"use client";

import { ChevronDown } from "lucide-react";
import {
  ArrowUp as ArrowUpIcon,
  ArrowUpRight as ArrowUpRightIcon,
  Radio as SignalIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { EXAMPLES } from "@scout/domain";
import { SketchArrow } from "@/components/ui/sketch-arrow";

import { useScoutAuth } from "../account/auth-context";
import { ScopeNote } from "../workspace/scope";
import { ScoutMark } from "../workspace/scout-mark";
import { ErrorNotice, Modal } from "../workspace/ui";
import { useWorkspace } from "../workspace/use-workspace";

import { setDraft, useDraft } from "./draft";
import { useCreateWatch } from "./mutations";

export function WatchComposer() {
  const draft = useDraft();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const { signedIn } = useWorkspace();
  const auth = useScoutAuth();
  const router = useRouter();
  const params = useSearchParams();
  const { mutateAsync: createWatch, isPending: busy } = useCreateWatch();
  const [error, setError] = useState<string | null>(null);
  const resumed = useRef(false);
  const submit = useCallback(async () => {
    const prompt = draft.trim();

    if (!prompt) {
      setError("Describe the onchain activity Scout should monitor.");
      promptRef.current?.focus();

      return;
    }

    if (!signedIn) {
      auth.login("/watches?create=1");

      return;
    }

    setError(null);

    try {
      const created = await createWatch(prompt);

      setDraft("");
      router.push(`/watches/${created.id}`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Scout could not save this request.",
      );
    }
  }, [auth, draft, router, signedIn, createWatch]);

  useEffect(() => {
    if (
      !signedIn ||
      params.get("create") !== "1" ||
      resumed.current ||
      !draft.trim()
    ) {
      return;
    }

    resumed.current = true;
    void submit();
  }, [signedIn, params, draft, submit]);
  useLayoutEffect(() => {
    const prompt = promptRef.current;

    if (!prompt) {
      return;
    }

    prompt.style.height = "auto";
    prompt.style.height = `${Math.min(prompt.scrollHeight, 224)}px`;
  }, [draft]);

  return (
    <section className="watch-intro" aria-labelledby="composer-heading">
      <div className="watch-intro-heading">
        <ScoutMark className="watch-intro-mark" />
        <h1 id="composer-heading">Describe what matters onchain.</h1>
        <p>
          Describe the signal. Scout builds the data pipeline, verifies it, and
          watches the chain continuously.
        </p>
      </div>
      <form
        className="watch-composer"
        data-testid="watch-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="watch-prompt" className="sr-only">
          Describe the onchain activity Scout should monitor
        </label>
        <textarea
          ref={promptRef}
          id="watch-prompt"
          placeholder="Describe the onchain activity Scout should monitor..."
          maxLength={2000}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-bottom">
          <Modal
            title="How Scout plans a monitor"
            description="Scout accepts generic onchain intent. Uniswap is its deepest first-class protocol integration."
            trigger={
              <button
                type="button"
                className="scope-chip"
                aria-label="View monitoring capabilities"
              >
                <SignalIcon />
                Onchain <span>· protocol-aware</span>
                <ChevronDown className="size-4" aria-hidden="true" />
              </button>
            }
          >
            <ScopeNote />
          </Modal>
          <div className="composer-submit-group">
            <span className="composer-shortcut" aria-hidden="true">
              ⌘ / Ctrl + Enter
            </span>
            <button
              className="composer-submit"
              type="submit"
              disabled={busy}
              aria-label="Create monitor"
              title="Create monitor (⌘ / Ctrl + Enter)"
            >
              {busy ? (
                <span
                  className="composer-spinner"
                  aria-label="Saving request"
                />
              ) : (
                <ArrowUpIcon aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </form>
      <p className="composer-capabilities">
        Natural language <SketchArrow /> Verified Substreams pipeline{" "}
        <SketchArrow /> Historical context <SketchArrow /> Live monitoring
      </p>
      <ErrorNotice message={error} />
      <div className="composer-examples">
        <span className="composer-example-label">Start with an example</span>
        <div className="example-row">
          {[
            "Watch $250K+ Uniswap swaps",
            "Detect large liquidity removals",
            "Follow unusual wallet activity",
            "Flag token volume spikes",
          ].map((label, i) => (
            <button
              key={label}
              onClick={() => {
                setDraft(EXAMPLES[i]!);
                document.getElementById("watch-prompt")?.focus();
              }}
            >
              {label}
              <ArrowUpRightIcon aria-hidden="true" />
            </button>
          ))}
        </div>
        {!signedIn && (
          <p className="composer-draft-note">Draft freely. No wallet needed.</p>
        )}
      </div>
    </section>
  );
}
