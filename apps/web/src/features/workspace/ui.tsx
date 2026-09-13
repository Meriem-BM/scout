"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {
  RefreshCw as ArrowPathIcon,
  Check as CheckIcon,
  Copy as DocumentDuplicateIcon,
  CircleAlert as ExclamationCircleIcon,
  X as XMarkIcon,
} from "lucide-react";
import { useState } from "react";

import {
  dialogContentClassName,
  dialogOverlayClassName,
  errorClassName,
  iconButtonClassName,
} from "./primitives";

export function Status({ status }: { status: string }) {
  const tone = [
    "watching",
    "live",
    "streaming",
    "current",
    "ready",
    "confirmed",
    "sent",
    "finalized",
    "connected",
    "verified",
    "delivered",
    "evidence ready",
  ].includes(status)
    ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
    : ["failed", "reverted", "retracted", "bounced", "suppressed"].includes(
          status,
        )
      ? "border-red-400/20 bg-red-400/10 text-red-300"
      : [
            "preparing",
            "checking",
            "starting",
            "backfilling",
            "delayed",
            "pending",
            "open",
          ].includes(status)
        ? "border-amber-400/20 bg-amber-400/10 text-amber-200"
        : "border-neutral-700 bg-neutral-800/60 text-neutral-300";

  return (
    <span
      className={`status-chip inline-flex shrink-0 items-center gap-2 rounded-full border border-transparent px-2.5 py-1 text-[13px] font-medium leading-4 ${tone}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export function ErrorNotice({
  message,
}: {
  message: string | null | undefined;
}) {
  return message ? (
    <div className={errorClassName} role="alert">
      <ExclamationCircleIcon className="size-5" />
      <span>{message}</span>
    </div>
  ) : null;
}

export function Busy({ label = "Working" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <ArrowPathIcon className="size-4 animate-spin motion-reduce:animate-none" />
      {label}
    </span>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  return (
    <>
      <button
        className={iconButtonClassName}
        aria-label={copied ? "Copied" : label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setError(false);
          } catch {
            setError(true);
          }
        }}
      >
        {copied ? (
          <CheckIcon className="size-4" />
        ) : (
          <DocumentDuplicateIcon className="size-4" />
        )}
      </button>
      {error && (
        <span role="status" className="break-all text-xs text-red-300">
          Copy unavailable: {value}
        </span>
      )}
    </>
  );
}

export function Modal({
  title,
  description,
  trigger,
  children,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  title: string;
  description: string;
  trigger?: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogContentClassName}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <div className="scout-dialog-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Dialog.Close
              className={iconButtonClassName}
              aria-label="Close dialog"
            >
              <XMarkIcon className="size-5" />
            </Dialog.Close>
          </div>
          <div className="scout-dialog-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
