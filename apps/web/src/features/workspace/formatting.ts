import { createContext, useContext } from "react";

export const shortAddress = (value: string) =>
  `${value.slice(0, 6)}…${value.slice(-4)}`;

export const TimezoneContext = createContext("UTC");

export function useDateTime() {
  const timezone = useContext(TimezoneContext);

  return (value: string | number) => dateTime(value, timezone);
}

export const dateTime = (value: string | number, displayTimezone = "UTC") =>
  new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: displayTimezone,
  }).format(new Date(typeof value === "number" ? value * 1000 : value)) +
  ` ${displayTimezone === "UTC" ? "UTC" : displayTimezone.split("/").pop()?.replaceAll("_", " ")}`;
