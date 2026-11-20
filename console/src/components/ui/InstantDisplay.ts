"use client";

import React from "react";

import { NOT_OBSERVED_LABEL } from "../status/StatusBadge.ts";
import { InlineDisplayToggle } from "./InlineDisplayToggle.ts";
import {
  instantLabel,
  isReadableInstant,
  localInstantText,
  relativeInstantText
} from "./instant.ts";

/**
 * How often relative times move on. Every rendered timestamp reads the same
 * clock, so a page with two hundred of them sets one timer, not two hundred.
 */
const CLOCK_TICK_MS = 30_000;

let clockNow = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const notify of clockListeners) notify();
    }, CLOCK_TICK_MS);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function readClock(): number {
  return clockNow;
}

/**
 * The server has no clock or zone of the operator's. Rendering "3 hours ago" or
 * a local time there would print the server's answer into the page and then
 * contradict it on hydration, so the server snapshot is "no clock" and the
 * server render shows the instant's storage form until the client takes over.
 */
function readServerClock(): number | null {
  return null;
}

/** `YYYY-MM-DD`: a day with no clock in it. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export interface InstantDisplayProps {
  /** The instant as the source wrote it (ISO-8601); absent when not observed. */
  readonly value: string | null | undefined;
  /** What moment this is, e.g. "Started"; names the control for assistive technology. */
  readonly label?: string | undefined;
}

/**
 * Every timestamp the Console shows: the shared inline display toggle, cycling
 * between relative time ("3 hours ago") and the full date and time in the
 * operator's local zone ("Nov 19, 2026, 10:30 AM").
 *
 * The machine-readable value stays in `dateTime`. Before hydration -- and for a value
 * that is not a readable instant -- the text is the instant's storage form
 * from `instantLabel`, which names its zone, so the page never shows a local
 * time computed in the server's zone. A moment the source did not record reads
 * "Not observed", so no caller decides that for itself.
 */
export function InstantDisplay({
  value,
  label = "Time"
}: InstantDisplayProps): React.JSX.Element {
  const now = React.useSyncExternalStore(
    subscribeClock,
    readClock,
    readServerClock
  );
  if (value === null || value === undefined || value.trim() === "") {
    return React.createElement("span", null, NOT_OBSERVED_LABEL);
  }
  const readable = isReadableInstant(value);
  // A calendar date names a day, not a moment: "3 hours ago" or a local clock
  // reading would invent a time (and, west of UTC, the previous day).
  if (!readable || now === null || CALENDAR_DATE.test(value)) {
    return React.createElement(
      "time",
      readable ? { dateTime: value } : null,
      instantLabel(value)
    );
  }
  const relative = relativeInstantText(value, now);
  const local = localInstantText(value);
  return React.createElement(
    "time",
    { dateTime: value },
    React.createElement(InlineDisplayToggle, {
      label,
      dataAttribute: "instant",
      representations: [
        { id: "relative", text: relative, name: "relative time" },
        { id: "local", text: local, name: "local date and time" }
      ]
    })
  );
}
