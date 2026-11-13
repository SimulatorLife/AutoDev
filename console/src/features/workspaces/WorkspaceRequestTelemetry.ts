"use client";

import React from "react";

import {
  type UsageTelemetryState,
  useUsageTelemetry
} from "../usage/use-usage-telemetry.ts";
import {
  type WorkspaceRequestLookup,
  workspaceRequestLookup,
  type WorkspaceRequestReading,
  workspaceRequestValue
} from "./workspace-usage.ts";

/**
 * The readings the table's rows share.
 *
 * The breakdown is read once for the whole table, not once per row: one
 * read answers every workspace, and a read per row would multiply the most
 * expensive thing the Console does by the number of rows. The rows learn
 * their own reading from here rather than asking for it themselves.
 */
interface WorkspaceRequestTelemetryValue {
  readonly readings: WorkspaceRequestLookup;
}

/**
 * The readings the table's rows share.
 *
 * A provider that is not there is a programming error rather than a state
 * to render, so the context has no default value: a cell that finds none
 * says it has no reading yet, which is the honest thing to say, rather than
 * inventing one.
 */
const WorkspaceRequestTelemetryContext =
  React.createContext<WorkspaceRequestTelemetryValue | null>(null);

/**
 * The reading each row shows, given what the browser knows.
 *
 * The three answers are the three the browser can have: the read has not
 * answered, it answered with a breakdown, or it could not be read. The
 * pending answer is a reading of its own rather than an empty one, because
 * a row whose number is on its way has not been measured as making no
 * requests.
 */
export function workspaceRequestReadings(
  state: UsageTelemetryState,
  workspaceIds: readonly string[]
): WorkspaceRequestLookup {
  const readings = new Map<string, WorkspaceRequestReading>();
  if (state.status === "pending") {
    // The read has not answered. Every row says so, and none of them says
    // zero: a number that has not arrived is not a measurement.
    for (const workspaceId of workspaceIds) {
      readings.set(workspaceId, { kind: "pending" });
    }
    return readings;
  }
  if (state.status === "unavailable") {
    for (const workspaceId of workspaceIds) {
      readings.set(workspaceId, { kind: "unavailable" });
    }
    return readings;
  }
  if (state.payload.scope !== "workspace-requests") {
    for (const workspaceId of workspaceIds) {
      readings.set(workspaceId, { kind: "unavailable" });
    }
    return readings;
  }
  return workspaceRequestLookup(state.payload.source, workspaceIds);
}

/**
 * Read the request breakdown once and hand it to the rows.
 *
 * The read is the browser's, not the page's: the page's content is about
 * the workspace catalogue, and the catalogue is answered in milliseconds
 * while the telemetry read is answered in minutes. The table therefore
 * renders with the rows it has and the numbers arrive afterwards, which is
 * why every row starts in the pending state rather than in a zero.
 */
export function WorkspaceRequestTelemetryProvider({
  workspaceIds,
  children
}: {
  readonly workspaceIds: readonly string[];
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const state = useUsageTelemetry("workspace-requests");
  const readings = workspaceRequestReadings(state, workspaceIds);
  return React.createElement(
    WorkspaceRequestTelemetryContext.Provider,
    { value: { readings } },
    children
  );
}

/**
 * One row's Requests cell.
 *
 * The cell renders the same value the workspace detail renders, from the
 * same vocabulary, so the two surfaces cannot drift into different words
 * for the same fact.
 */
export function WorkspaceRequestCell({
  workspaceId
}: {
  readonly workspaceId: string;
}): React.JSX.Element {
  const telemetry = React.useContext(WorkspaceRequestTelemetryContext);
  const reading = telemetry?.readings.get(workspaceId);
  return workspaceRequestValue(reading ?? { kind: "pending" });
}
