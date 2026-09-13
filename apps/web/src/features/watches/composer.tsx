"use client";

import {
  ArrowUp as ArrowUpIcon,
  ArrowUpRight as ArrowUpRightIcon,
  Radio as SignalIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useScoutAuth } from "../account/auth-context";
import { useCapabilities } from "../capabilities/queries";
import { ProtocolMark } from "../workspace/protocol-mark";
import { ScoutMark } from "../workspace/scout-mark";
import { ErrorNotice } from "../workspace/ui";
import { useWorkspace } from "../workspace/use-workspace";

import { setDraft, useDraft } from "./draft";
import { useCreateWatch } from "./mutations";

export function WatchComposer() {
  const draft = useDraft();
  const capabilities = useCapabilities();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const { signedIn } = useWorkspace();
  const auth = useScoutAuth();
  const router = useRouter();
  const params = useSearchParams();
  const { mutateAsync: createWatch, isPending: busy } = useCreateWatch();
  const [error, setError] = useState<string | null>(null);
  const resumed = useRef(false);
  const selectedExample = params.get("example");

  useEffect(() => {
    const example = capabilities.data?.examples.find(
      (item) => item.id === selectedExample,
    );

    if (example) {
      setDraft(example.prompt);
    }
  }, [selectedExample, capabilities.data]);

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
          Scout turns your request into a verified live monitor using the
          blockchain data it knows how to access.
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
          <Link className="scope-chip" href="/capabilities">
            <SignalIcon /> What can Scout watch? →
          </Link>
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
        Scout checks whether it has the data and monitoring tools needed before
        building the Watch.
      </p>
      <ErrorNotice message={error} />
      <div className="composer-examples">
        <span className="composer-example-label">Try an available setup</span>
        <div className="example-row">
          {(capabilities.data?.examples ?? []).map((starter) => {
            const protocol = capabilities.data?.protocols.find(
              (entry) => entry.id === starter.adapterId,
            )?.protocol;

            return (
              <button
                key={starter.id}
                onClick={() => {
                  setDraft(starter.prompt);
                  document.getElementById("watch-prompt")?.focus();
                }}
              >
                <ProtocolMark
                  protocol={protocol ?? starter.adapterId}
                  size={20}
                />
                <span>
                  {starter.label}
                  <small>{starter.description}</small>
                </span>
                <ArrowUpRightIcon aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <p className="composer-draft-note">
          Examples use supported monitoring rules. Live activation still
          requires connected providers and successful verification.
        </p>
        {!signedIn && (
          <p className="composer-draft-note">Draft freely. No wallet needed.</p>
        )}
      </div>
    </section>
  );
}
