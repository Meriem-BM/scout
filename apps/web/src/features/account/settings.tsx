"use client";

import { ArrowUpRight as ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import { PreferencesSchema } from "@scout/domain";

import { ServiceIcon } from "../connections/connections";
import { api, Ok } from "../workspace/api";
import { buttonClassName } from "../workspace/primitives";
import { Select } from "../workspace/select";
import { Busy, ErrorNotice } from "../workspace/ui";
import { useWorkspace } from "../workspace/use-workspace";

import { useScoutAuth } from "./auth-context";
import { SignInButton } from "./sign-in-button";

const INITIAL_TIMEZONES = [
  "UTC",
  "Africa/Casablanca",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const;

const subscribeToHydration = () => () => {};

export function Settings() {
  const { state, email, signedIn, refresh } = useWorkspace();
  const router = useRouter();
  const auth = useScoutAuth();
  const [draftPreferences, setPrefs] = useState<
    typeof state.preferences | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const prefs = draftPreferences ?? state.preferences;
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const timezones = [
    ...new Set([
      ...INITIAL_TIMEZONES,
      prefs.timezone,
      ...(hydrated ? Intl.supportedValuesOf("timeZone") : []),
    ]),
  ];

  const save = async () => {
    setBusy(true);
    setError(null);

    try {
      const valid = PreferencesSchema.parse(prefs);

      await api("/api/preferences", Ok, { method: "PATCH", body: valid });
      await refresh();

      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save preferences.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="preferences-page">
      <div className="page-heading">
        <h1>Settings</h1>
      </div>
      <h2 className="group-label">Account</h2>
      <div className="preference-group">
        <div className="preference-row">
          <div>
            <h3>Email address</h3>
            <p>
              {email ??
                (signedIn
                  ? "Signed in with a wallet"
                  : "Sign in to save your watches")}
            </p>
          </div>
          {!signedIn ? (
            <SignInButton className={buttonClassName()} destination="/settings">
              Sign in
            </SignInButton>
          ) : (
            <span className="row-value">Verified</span>
          )}
        </div>
        <div className="preference-row">
          <div>
            <h3>Timezone</h3>
            <p>Display activity and alerts in your local time.</p>
          </div>
          <Select
            aria-label="Display timezone"
            value={prefs.timezone}
            onValueChange={(value) => {
              setPrefs({ ...prefs, timezone: value });
              setSaved(false);
            }}
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <h2 className="group-label">Default alert destinations</h2>
      <div className="preference-group">
        {(["telegram", "email"] as const).map((channel) => (
          <label className="preference-row" key={channel}>
            <ServiceIcon service={channel} />
            <div className="grow">
              <h3>{channel === "telegram" ? "Telegram" : "Email"}</h3>
              <p>
                {channel === "telegram"
                  ? (state.telegram.label ?? "No private chat connected")
                  : (state.emailConnection.address ??
                    "No verified email connected")}
              </p>
            </div>
            <input
              className="scout-switch"
              type="checkbox"
              aria-label={`Use ${channel} by default`}
              checked={prefs[channel]}
              onChange={(e) => {
                setPrefs({ ...prefs, [channel]: e.target.checked });
                setSaved(false);
              }}
            />
          </label>
        ))}
        <Link href="/connections" className="preference-row row-link">
          <span>Manage connections</span>
          <ArrowUpRightIcon />
        </Link>
      </div>
      <p className="group-caption">
        Applies to watches using account defaults. Alerts send only to verified,
        enabled destinations.
      </p>
      <h2 className="group-label">Incident grouping</h2>
      <div className="preference-group">
        <div className="preference-row">
          <div>
            <h3>Group related activity</h3>
            <p>Default window for new watches.</p>
          </div>
          <Select
            aria-label="Default incident grouping"
            value={prefs.cooldownSeconds}
            onValueChange={(value) => {
              setPrefs({ ...prefs, cooldownSeconds: Number(value) });
              setSaved(false);
            }}
          >
            {[300, 900, 1800, 3600].map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds / 60} minutes
              </option>
            ))}
          </Select>
        </div>
      </div>
      <p className="group-caption">
        One first alert per initiator or pool in each window. Later matches
        update the incident. Existing watches keep their reviewed rules.
      </p>
      <div className="preferences-save">
        <button
          className={buttonClassName()}
          disabled={busy || !signedIn}
          onClick={() => void save()}
        >
          {busy ? <Busy label="Saving" /> : "Save preferences"}
        </button>
        {saved && <span role="status">Preferences saved.</span>}
      </div>
      <ErrorNotice message={error} />
      <h2 className="group-label">Session</h2>
      <div className="preference-group">
        <div className="preference-row">
          <div>
            <h3>Sign out</h3>
            <p>Your watches continue monitoring while you&apos;re away.</p>
          </div>
          {signedIn || auth.hasSession ? (
            <button
              className={buttonClassName()}
              onClick={async () => {
                try {
                  await auth.logout();
                  router.replace("/watches");
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Sign out could not finish.",
                  );
                }
              }}
            >
              Sign out
            </button>
          ) : (
            <span className="row-value">Not signed in</span>
          )}
        </div>
      </div>
    </section>
  );
}
