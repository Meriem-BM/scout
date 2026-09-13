"use client";

import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Undo2 as ArrowUturnLeftIcon,
  Bell as BellIcon,
  BellOff as BellSlashIcon,
  Copy as DocumentDuplicateIcon,
  Ellipsis as EllipsisHorizontalIcon,
  Pause as PauseIcon,
  SquarePen as PencilSquareIcon,
  Play as PlayIcon,
  Radio as SignalIcon,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { z } from "zod";

import { describeCondition } from "@scout/domain";

import { api } from "../workspace/api";
import { buttonClassName } from "../workspace/primitives";
import { Busy, ErrorNotice, Modal } from "../workspace/ui";

import { useWatchAction } from "./mutations";

import type { Watch } from "@scout/domain";

export function RuleSummary({ watch }: { watch: Watch }) {
  const spec = watch.spec?.protocol === "uniswap_v3" ? watch.spec : null;

  if (!spec) {
    return <span>{watch.prompt}</span>;
  }

  return (
    <>
      {spec.conditions.map((condition, i) => (
        <span key={i}>
          {i > 0 ? (spec.combine === "all" ? "; and " : "; or ") : ""}
          {describeCondition(condition)
            .split(/(\$[\d,.]+|\d+ minutes|\d+\+ distinct transactions)/g)
            .map((part, j) =>
              /^(\$|\d+ minutes|\d+\+)/.test(part) ? (
                <strong key={j}>{part}</strong>
              ) : (
                part
              ),
            )}
        </span>
      ))}
    </>
  );
}

export function WatchManagement({ watch }: { watch: Watch }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const spec = watch.spec?.protocol === "uniswap_v3" ? watch.spec : null;
  const watchAction = useWatchAction();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const act = async (action: Parameters<typeof watchAction>[1]) => {
    setBusy(true);
    setError(null);

    try {
      await watchAction(watch.id, action);
      setOpen(false);
      setConfirmDelete(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update watch.");
    } finally {
      setBusy(false);
    }
  };

  const item = (
    label: string,
    icon: React.ReactNode,
    action: Parameters<typeof watchAction>[1],
  ) => (
    <Menu.Item
      className="scout-menu-item"
      disabled={busy}
      onSelect={(e) => {
        e.preventDefault();
        void act(action);
      }}
    >
      {icon}
      {label}
    </Menu.Item>
  );

  return (
    <>
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Menu.Trigger asChild>
          <button
            ref={triggerRef}
            className="control-icon"
            aria-label={`Manage ${watch.name}`}
          >
            <EllipsisHorizontalIcon />
          </button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className="scout-menu action-menu"
            align="end"
            sideOffset={5}
            collisionPadding={12}
            onCloseAutoFocus={(event) => {
              if (confirmDelete) {
                event.preventDefault();
              }
            }}
          >
            <Menu.Label className="menu-label">Manage watch</Menu.Label>
            {spec && (
              <Menu.Item asChild className="scout-menu-item">
                <Link href={`/new?edit=${watch.id}`}>
                  <PencilSquareIcon />
                  Edit name and rule
                </Link>
              </Menu.Item>
            )}
            {watch.status !== "archived" &&
            watch.workflowId &&
            watch.workflowStage !== "LIVE" ? (
              <Menu.Item asChild className="scout-menu-item">
                <Link href={`/watches/${watch.id}`}>
                  <SignalIcon />
                  Review workflow
                </Link>
              </Menu.Item>
            ) : watch.status === "draft" ? (
              <Menu.Item asChild className="scout-menu-item">
                <Link href={`/new?edit=${watch.id}`}>
                  <PlayIcon />
                  Review and activate
                </Link>
              </Menu.Item>
            ) : watch.status === "archived" ? (
              item("Restore watch", <ArrowUturnLeftIcon />, "restore")
            ) : (
              item(
                watch.status === "failed"
                  ? "Retry preparation"
                  : watch.status === "paused"
                    ? "Resume watch"
                    : "Pause watch",
                watch.status === "paused" ? <PlayIcon /> : <PauseIcon />,
                ["paused", "failed"].includes(watch.status)
                  ? "resume"
                  : "pause",
              )
            )}
            {spec && <Menu.Separator className="menu-separator" />}
            {spec && item("Mute alerts for 1 hour", <BellSlashIcon />, "mute")}
            {spec && item("Unmute alerts", <BellIcon />, "unmute")}
            {spec && (
              <Menu.Item
                className="scout-menu-item"
                disabled={busy}
                onSelect={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError(null);

                  try {
                    const result = await api(
                      "/api/watches",
                      z.object({ id: z.string().uuid() }),
                      { method: "POST", body: { duplicateId: watch.id } },
                    );

                    setOpen(false);
                    router.push(`/watches/${result.id}`);
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : "Could not duplicate watch.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <DocumentDuplicateIcon />
                Duplicate as draft
              </Menu.Item>
            )}
            {watch.status !== "archived" && (
              <>
                <Menu.Separator className="menu-separator" />
                <Menu.Item
                  className="scout-menu-item text-red-300"
                  disabled={busy}
                  onSelect={() => {
                    setError(null);
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  Delete watch
                </Menu.Item>
              </>
            )}
            {busy && (
              <div className="menu-feedback">
                <Busy label="Saving change" />
              </div>
            )}
            {error && (
              <div className="menu-feedback">
                <ErrorNotice message={error} />
              </div>
            )}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <Modal
        title="Delete this Watch?"
        description="This stops monitoring, removes the Watch from your active list, and frees a Watch slot. Saved history is kept in Archived, where you can restore it."
        open={confirmDelete}
        onCloseAutoFocus={(event) => {
          if (triggerRef.current) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}
        onOpenChange={(value) => {
          if (!busy) {
            setConfirmDelete(value);
          }
        }}
      >
        <p className="mb-4 break-words">{watch.name}</p>
        <ErrorNotice message={error} />
        <div className="mt-5 flex justify-end gap-3">
          <button
            className={buttonClassName("quiet")}
            disabled={busy}
            onClick={() => setConfirmDelete(false)}
          >
            Cancel
          </button>
          <button
            className={buttonClassName("danger")}
            disabled={busy}
            onClick={() => void act("archive")}
          >
            {busy ? (
              <Busy label="Deleting" />
            ) : (
              <>
                <Trash2 className="size-4" aria-hidden="true" />
                Delete watch
              </>
            )}
          </button>
        </div>
      </Modal>
    </>
  );
}
