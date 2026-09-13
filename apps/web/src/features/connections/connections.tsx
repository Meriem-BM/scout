"use client";

import {
  ArrowUpRight as ArrowUpRightIcon,
  MessagesSquare as ChatBubbleLeftRightIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  Mail as EnvelopeIcon,
  Send as PaperAirplaneIcon,
  Plus as PlusIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

import { watchChannels, watchHealth } from "@scout/domain";

import { SignInButton } from "../account/sign-in-button";
import { api, Ok } from "../workspace/api";
import { useClock } from "../workspace/clock";
import { useDateTime } from "../workspace/formatting";
import { Popover } from "../workspace/popover";
import {
  buttonClassName,
  inputClassName,
  noticeClassName,
  warningClassName,
} from "../workspace/primitives";
import { ConnectionsSkeleton } from "../workspace/skeletons";
import { Busy, ErrorNotice, Modal, Status } from "../workspace/ui";
import { useWorkspace } from "../workspace/use-workspace";

import { useConnectionMutation, useConnections } from "./hooks";

import type { Watch } from "@scout/domain";

export function ServiceIcon({
  service,
}: {
  service: "telegram" | "email" | "discord";
}) {
  const Icon =
    service === "telegram"
      ? PaperAirplaneIcon
      : service === "email"
        ? EnvelopeIcon
        : ChatBubbleLeftRightIcon;

  return (
    <span className="service-icon" data-service={service} aria-hidden="true">
      {service === "email" ? (
        <Icon />
      ) : (
        <Image src={`/brands/${service}.svg`} width={32} height={32} alt="" />
      )}
    </span>
  );
}

export function ConnectionControls({ only }: { only?: "telegram" | "email" }) {
  const dateTime = useDateTime();
  const { signedIn, email, state, refresh, loading } = useWorkspace();
  const now = useClock();
  const [pair, setPair] = useState<{ url: string; expiresAt: string } | null>(
    null,
  );
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState<"telegram" | "email" | null>(
    null,
  );
  const config = useConnections(signedIn);
  const connection = useConnectionMutation(refresh);

  const execute = async (channel: "telegram" | "email", action: string) => {
    setBusy(`${channel}:${action}`);
    setError(null);
    setMessage(null);

    try {
      if (channel === "telegram" && action === "pair") {
        const result = await connection.mutateAsync({
          channel,
          action,
          address,
        });

        if ("url" in result) {
          setPair(result);
        }
      } else {
        await connection.mutateAsync({ channel, action, address });
        setMessage(
          action === "test"
            ? "Test alert queued. Its actual send result will appear here."
            : action === "verify"
              ? "Verification email queued. Open the link in your email within 10 minutes."
              : "Connection updated.",
        );

        if (action === "disconnect") {
          setDisconnect(null);
          setPair(null);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update connection.");
    } finally {
      setBusy(null);
    }
  };

  if (signedIn && (loading || config.isLoading)) {
    return <ConnectionsSkeleton single={!!only} />;
  }

  const ec = state.emailConnection;
  const waiting = pair && Date.parse(pair.expiresAt) > now;
  const tgMuted =
    state.telegram.mutedUntil && Date.parse(state.telegram.mutedUntil) > now;
  const active = state.watches.filter(
    (w) => !["draft", "archived", "paused"].includes(w.status),
  );

  return (
    <div className="connection-controls">
      {!signedIn && (
        <div className={`${noticeClassName} mb-5`}>
          <span>
            <SignInButton
              destination="/connections"
              className="underline underline-offset-4"
            >
              Sign in
            </SignInButton>{" "}
            to verify your alert destinations. A wallet is not required.
          </span>
        </div>
      )}
      <ErrorNotice message={error ?? config.error?.message} />
      {message && (
        <p className={`${noticeClassName} my-4`} role="status">
          {message}
        </p>
      )}
      {(!only || only === "telegram") && (
        <section className="connection-row" data-channel="telegram">
          <ServiceIcon service="telegram" />
          <div className="connection-body">
            <div className="connection-row-header">
              <h2>Telegram</h2>
              <Status
                status={
                  busy === "telegram:pair"
                    ? "connecting"
                    : pair && !state.telegram.connected
                      ? waiting
                        ? "waiting for you"
                        : "expired"
                      : state.telegram.error
                        ? "failed"
                        : state.telegram.connected
                          ? "connected"
                          : config.data && !config.data.telegramConfigured
                            ? "setup required"
                            : "not connected"
                }
              />
            </div>
            <p>
              {state.telegram.connected
                ? (state.telegram.label ?? "Verified private chat")
                : "A private chat with the Scout bot."}
            </p>
            {state.telegram.connected && (
              <div className="connection-note">
                {tgMuted
                  ? `Muted until ${dateTime(state.telegram.mutedUntil!)}`
                  : "Enabled · verified Telegram account"}
                {config.data?.telegramTest?.status && (
                  <p className="mt-2">
                    Last test:{" "}
                    <strong>
                      {config.data.telegramTest.status === "sent"
                        ? "Sent to Telegram"
                        : config.data.telegramTest.status}
                    </strong>
                    {config.data.telegramTest.sentAt
                      ? ` · ${dateTime(config.data.telegramTest.sentAt)}`
                      : ""}
                    . API acceptance does not indicate a read receipt.
                  </p>
                )}
              </div>
            )}
            <ErrorNotice
              message={state.telegram.error ?? config.data?.telegramTest?.error}
            />
            {config.data && !config.data.telegramConfigured && (
              <p className="card-notice">
                Setup required: configure the Scout bot and its authenticated
                webhook.
              </p>
            )}
            <div className="connection-actions">
              <button
                className={buttonClassName(
                  state.telegram.connected ? "default" : "primary",
                )}
                disabled={
                  !!busy || !signedIn || !config.data?.telegramConfigured
                }
                onClick={() => void execute("telegram", "pair")}
              >
                {busy === "telegram:pair" ? (
                  <Busy label="Connecting" />
                ) : state.telegram.connected ? (
                  "Reconnect"
                ) : (
                  "Connect Telegram"
                )}
              </button>
              {state.telegram.connected && (
                <>
                  <button
                    className={buttonClassName()}
                    disabled={!!busy}
                    onClick={() => void execute("telegram", "test")}
                  >
                    Send test alert
                  </button>
                  <button
                    className={buttonClassName("quiet")}
                    disabled={!!busy}
                    onClick={() =>
                      void execute("telegram", tgMuted ? "unmute" : "mute")
                    }
                  >
                    {tgMuted ? "Enable alerts" : "Mute 1 hour"}
                  </button>
                  <button
                    className={buttonClassName("quiet")}
                    onClick={() => setDisconnect("telegram")}
                  >
                    Disconnect
                  </button>
                </>
              )}
            </div>
            {pair && (
              <div className="connection-note" role="status">
                {waiting ? (
                  <>
                    <strong>Waiting for you in Telegram</strong>
                    <p>
                      Open the private bot chat and tap Start. One-time link ·
                      expires {dateTime(pair.expiresAt)}.
                    </p>
                    <a
                      className={buttonClassName("primary", "mt-3")}
                      href={pair.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Telegram <ArrowUpRightIcon className="size-4" />
                    </a>
                  </>
                ) : (
                  <>
                    <strong>Pairing link expired</strong>
                    <p>Create a new link to continue.</p>
                  </>
                )}
              </div>
            )}
          </div>
        </section>
      )}
      {(!only || only === "email") && (
        <section className="connection-row" data-channel="email">
          <ServiceIcon service="email" />
          <div className="connection-body">
            <div className="connection-row-header">
              <h2>Email</h2>
              <Status
                status={
                  ec.suppressed
                    ? "suppressed"
                    : ec.verified
                      ? ec.enabled
                        ? "verified"
                        : "disabled"
                      : ec.pendingAddress
                        ? ec.expiresAt && Date.parse(ec.expiresAt) <= now
                          ? "expired"
                          : "verification pending"
                        : config.data && !config.data.emailConfigured
                          ? "setup required"
                          : "not connected"
                }
              />
            </div>
            <p>{ec.address ?? "The evidence, delivered to your email."}</p>
            {ec.verified && (
              <div className="connection-note">
                <span className="inline-flex items-center gap-2">
                  <CheckIcon className="size-4 tone-success" />
                  Verified destination · {ec.enabled ? "Enabled" : "Disabled"}
                </span>
                {ec.lastStatus && (
                  <p className="mt-2">
                    Latest email: <strong>{ec.lastStatus}</strong>
                    {ec.lastSentAt ? ` · ${dateTime(ec.lastSentAt)}` : ""}.{" "}
                    {ec.lastStatus === "delivered"
                      ? "Recipient mail server accepted the email."
                      : "Sent means provider acceptance; inbox arrival is not confirmed."}
                  </p>
                )}
              </div>
            )}
            <ErrorNotice message={ec.error} />
            {config.data && !config.data.emailConfigured && (
              <p className="card-notice">
                Setup required: configure Resend, a verified sender domain, and
                the signed delivery webhook.
              </p>
            )}
            {(!ec.verified || ec.suppressed) && email && (
              <button
                className={buttonClassName("default", "mt-4")}
                disabled={!!busy || !config.data?.emailConfigured}
                onClick={() => void execute("email", "use-account")}
              >
                Use my verified account email
              </button>
            )}
            <details className="mt-3" open={!ec.verified || undefined}>
              <summary className="text-sm text-neutral-300">
                {ec.verified
                  ? "Change destination email"
                  : "Verify an email destination"}
              </summary>
              <form
                className="mt-2 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void execute("email", "verify");
                }}
              >
                <label className="block text-sm" htmlFor="destination-email">
                  Alert email
                </label>
                <input
                  id="destination-email"
                  className={inputClassName}
                  type="email"
                  required
                  maxLength={254}
                  placeholder="you@example.com"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
                <p className="text-[13px] text-neutral-400">
                  Connecting opts this address in to Scout alerts. Sign-in
                  emails are separate.
                  {ec.verified
                    ? " Your current destination stays in place until the new address is verified."
                    : ""}
                </p>
                <button
                  className={buttonClassName("primary")}
                  disabled={
                    !!busy || !signedIn || !config.data?.emailConfigured
                  }
                >
                  {busy === "email:verify" ? (
                    <Busy label="Queuing verification" />
                  ) : (
                    "Send verification email"
                  )}
                </button>
              </form>
            </details>
            {ec.pendingAddress && (
              <div className="connection-note">
                {ec.expiresAt && Date.parse(ec.expiresAt) <= now
                  ? "Verification expired"
                  : "Waiting for verification"}{" "}
                · {ec.pendingAddress}.{" "}
                {ec.expiresAt ? `Link expires ${dateTime(ec.expiresAt)}.` : ""}
              </div>
            )}
            {ec.verified && (
              <div className="connection-actions">
                <button
                  className={buttonClassName()}
                  disabled={
                    !!busy ||
                    ec.suppressed ||
                    !ec.enabled ||
                    !config.data?.emailConfigured
                  }
                  onClick={() => void execute("email", "test")}
                >
                  Send test alert
                </button>
                <button
                  className={buttonClassName("quiet")}
                  disabled={!!busy || ec.suppressed}
                  onClick={() =>
                    void execute("email", ec.enabled ? "disable" : "enable")
                  }
                >
                  {ec.enabled ? "Disable alerts" : "Enable alerts"}
                </button>
                <button
                  className={buttonClassName("quiet")}
                  onClick={() => setDisconnect("email")}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </section>
      )}
      {disconnect && (
        <div className={`${warningClassName} mt-5`}>
          <div>
            <strong>
              Disconnect {disconnect === "email" ? "email" : "Telegram"}?
            </strong>
            <p>
              {active.length} running{" "}
              {active.length === 1 ? "watch" : "watches"} may use this
              destination. Monitoring and history continue. Watches without
              another enabled destination will stop sending alerts.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className={buttonClassName("danger")}
                disabled={!!busy}
                onClick={() => void execute(disconnect, "disconnect")}
              >
                Disconnect destination
              </button>
              <button
                className={buttonClassName()}
                onClick={() => setDisconnect(null)}
              >
                Keep connection
              </button>
            </div>
            <Link
              className="block mt-2"
              href="/connections"
              onClick={() => setDisconnect(null)}
            >
              Review replacement destinations
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export function ConnectionPopover({ watch }: { watch: Watch }) {
  const { state, refresh } = useWorkspace();
  const now = useClock();
  const channels = watchChannels(watch, state);
  const health = watchHealth(watch, state, now);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (
    value: { telegram: boolean; email: boolean } | null,
  ) => {
    setPending(true);
    setError(null);

    try {
      await api("/api/watches", Ok, {
        method: "PUT",
        body: { id: watch.id, channels: value },
      });
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not update destinations.",
      );
    } finally {
      setPending(false);
    }
  };

  const enabledLabel =
    channels.telegram && channels.email
      ? "Telegram + Email"
      : channels.telegram
        ? "Telegram"
        : channels.email
          ? "Email"
          : "Connect alerts";
  const label =
    health.delivery === "Needs connection"
      ? channels.telegram && !channels.email
        ? "Connect Telegram"
        : channels.email && !channels.telegram
          ? "Connect email"
          : "Connect alerts"
      : health.delivery === "Delivery failed"
        ? "Fix alert delivery"
        : enabledLabel;

  return (
    <Popover
      title="Alert destinations"
      description={`${watch.name} · ${(watch.spec?.notifications.useDefaults ?? true) ? "Using account defaults" : "Overrides for this watch"}`}
      trigger={
        <button
          className="connection-trigger"
          aria-label={`Alert destinations for ${watch.name}`}
        >
          <span className="service-stack">
            {channels.telegram && <ServiceIcon service="telegram" />}
            {channels.email && <ServiceIcon service="email" />}
            {!channels.telegram && !channels.email && (
              <ServiceIcon service="email" />
            )}
          </span>
          <span>{label}</span>
          <ChevronDownIcon />
        </button>
      }
    >
      <label className="defaults-row">
        <span>Use account defaults</span>
        <input
          className="scout-switch"
          type="checkbox"
          disabled={pending}
          checked={watch.spec?.notifications.useDefaults ?? true}
          onChange={(e) =>
            void change(
              e.target.checked
                ? null
                : { telegram: channels.telegram, email: channels.email },
            )
          }
        />
      </label>
      {(["telegram", "email"] as const).map((channel) => (
        <div key={channel} className="connection-detail-row">
          <ServiceIcon service={channel} />
          <div>
            <h3>{channel === "telegram" ? "Telegram" : "Email"}</h3>
            <p>
              {channel === "telegram"
                ? (state.telegram.label ?? "No private chat connected")
                : (state.emailConnection.address ?? "No verified email")}
            </p>
            <p>
              {health[channel] ? "Ready to send" : "Connection needs attention"}
            </p>
          </div>
          <label>
            <input
              aria-label={`Enable ${channel} for this watch`}
              className="scout-switch"
              type="checkbox"
              checked={channels[channel]}
              disabled={
                pending || (watch.spec?.notifications.useDefaults ?? true)
              }
              onChange={(e) =>
                void change({
                  telegram: channels.telegram,
                  email: channels.email,
                  [channel]: e.target.checked,
                })
              }
            />
          </label>
        </div>
      ))}
      <p className="mt-4 text-sm text-neutral-400">
        {health.muted
          ? "This watch is muted. Monitoring and history continue."
          : "Each enabled destination gets its own delivery record."}
      </p>
      <ErrorNotice message={error} />
      <Link href="/connections" className={buttonClassName("primary", "mt-5")}>
        Manage connections <ArrowUpRightIcon className="size-4" />
      </Link>
    </Popover>
  );
}

export function Connections() {
  const { state } = useWorkspace();

  const status = (channel: "telegram" | "email") => {
    if (channel === "telegram") {
      return state.telegram.error
        ? "Needs attention"
        : state.telegram.connected
          ? "Connected"
          : "Not connected";
    }

    return state.emailConnection.suppressed
      ? "Suppressed"
      : state.emailConnection.verified
        ? state.emailConnection.enabled
          ? "Connected"
          : "Disabled"
        : state.emailConnection.pendingAddress
          ? "Verification pending"
          : "Not connected";
  };

  return (
    <section className="preferences-page connections-page">
      <div className="page-heading">
        <h1>Connections</h1>
      </div>
      <div className="connection-intro">
        <div>
          <h2>Scout, wherever you are</h2>
          <p>
            Get the onchain activity that matters in Telegram or your email,
            with the evidence one click away.
          </p>
        </div>
      </div>
      <h2 className="group-label">Alert destinations</h2>
      <div className="preference-group destination-list">
        {(["telegram", "email"] as const).map((channel) => (
          <Modal
            key={channel}
            title={
              channel === "telegram"
                ? "Telegram connection"
                : "Email connection"
            }
            description="Connect a verified destination for Scout alerts."
            trigger={
              <button
                className="destination-row"
                aria-label={`Manage ${channel === "telegram" ? "Telegram" : "Email"} connection`}
              >
                <ServiceIcon service={channel} />
                <span className="destination-name">
                  {channel === "telegram" ? "Telegram" : "Email"}
                </span>
                <span className="destination-status">{status(channel)}</span>
                <span className="destination-action">
                  <PlusIcon />
                </span>
              </button>
            }
          >
            <ConnectionControls only={channel} />
          </Modal>
        ))}
        <div className="destination-row upcoming">
          <ServiceIcon service="discord" />
          <span className="destination-name">Discord</span>
          <span className="destination-status">Coming later</span>
        </div>
      </div>
      <p className="group-caption">
        Choose Telegram, email, or both for each watch. Your incident history
        always stays in Scout.
      </p>
      <h2 className="group-label">Preferences</h2>
      <div className="preference-group">
        <Link href="/settings" className="preference-row row-link">
          <div>
            <h3>Default destinations</h3>
            <p>Choose where new watches send alerts.</p>
          </div>
          <ArrowUpRightIcon />
        </Link>
      </div>
    </section>
  );
}
