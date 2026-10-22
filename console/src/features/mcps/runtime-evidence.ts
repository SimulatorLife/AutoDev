import type {
  ControlApiMcpRuntimeEvidence,
  ControlApiMcpRuntimeHealth
} from "@simulatorlife/autodev-core";
import React from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { FieldBox } from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

const FLEX_COLUMN_DETAILS_CLASS = "flex flex-col gap-2";

/**
 * The Runtime's health verdict for a server, in the Console's status tone.
 *
 * `ready` and `error` are verdicts and get the success and error tones.
 * `configured` means the Runtime saw the server named in a session but never
 * exercised it, and `observed` means it saw a span that carried no readiness
 * signal: neither is a correctness claim, so neither gets the success tone.
 * `stale` means the Runtime saw the server, but not recently enough to call
 * it ready.
 *
 * The badge's label always carries the Runtime's own word, so the tone never
 * becomes the only record of what the Runtime reported.
 */
export function runtimeHealthStatus(
  health: ControlApiMcpRuntimeHealth
): StatusBadgeVariant {
  if (health === "ready") return "ready";
  if (health === "error") return "error";
  if (health === "configured") return "configured";
  return "unavailable";
}

/**
 * The Runtime's own evidence about one server.
 *
 * Every number here is a count the Runtime recorded. The page does not derive
 * a verdict from the declaration and does not present the declaration as
 * evidence: a server that was declared but never reached says "Not observed",
 * and only a server the Runtime has seen reports counts.
 *
 * `observationAvailable` separates the two ways there can be no evidence: the
 * observation read could not be read at all, and the Runtime read it and had
 * seen nothing. The page says which, because "we could not ask" and "we asked
 * and it has not been reached" are different facts.
 */
export function McpRuntimeEvidence({
  evidence,
  observationAvailable = true
}: {
  readonly evidence: ControlApiMcpRuntimeEvidence | null;
  readonly observationAvailable?: boolean;
}): React.JSX.Element {
  if (!observationAvailable) {
    return React.createElement(
      "div",
      { className: FLEX_COLUMN_DETAILS_CLASS },
      React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: "Runtime evidence: Not observed"
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "The Runtime's observation could not be read. Nothing is claimed about this server until the Runtime reports what it has seen."
      )
    );
  }
  if (!evidence) {
    return React.createElement(
      "div",
      { className: FLEX_COLUMN_DETAILS_CLASS },
      React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: "Runtime evidence: Not observed"
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "The Runtime has not observed this server. A declaration is not a reached server: the runtime evidence appears once the server has been seen in a session."
      )
    );
  }
  return React.createElement(
    "div",
    { className: FLEX_COLUMN_DETAILS_CLASS },
    React.createElement(StatusBadge, {
      status: runtimeHealthStatus(evidence.health),
      label: `Runtime health: ${evidence.health}`
    }),
    React.createElement(
      "dl",
      { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
      React.createElement(
        FieldBox,
        { label: "Last seen" },
        evidence.lastSeenAt ?? NOT_OBSERVED_LABEL
      ),
      React.createElement(
        FieldBox,
        { label: "Last status" },
        evidence.lastStatus
      ),
      React.createElement(
        FieldBox,
        { label: "Initialization attempts" },
        String(evidence.initAttempts)
      ),
      React.createElement(
        FieldBox,
        { label: "Tool discovery attempts" },
        String(evidence.toolDiscoveryAttempts)
      )
    )
  );
}

/**
 * The tools the Runtime has observed being called on this server.
 *
 * These are calls the Runtime saw, not the server's tool inventory: a tool
 * the server offers but nothing has called is absent, and a tool the server
 * no longer offers may still be listed. The heading says so, because the
 * configured allowlist above it is a different thing and the page keeps the
 * two apart.
 */
export function McpObservedTools({
  evidence
}: {
  readonly evidence: ControlApiMcpRuntimeEvidence | null;
}): React.JSX.Element | null {
  if (!evidence || evidence.tools.length === 0) return null;
  return React.createElement(
    "div",
    { className: "mt-4" },
    React.createElement(
      "h4",
      { className: SECTION_HEADING_CLASS },
      "Observed tool calls"
    ),
    React.createElement(
      "p",
      { className: `mb-2 ${MUTED_META_CLASS}` },
      "Tools the Runtime has observed being called on this server. This is what was seen in use, not the server's full tool inventory."
    ),
    React.createElement(
      "dl",
      { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
      ...evidence.tools.map((tool) =>
        React.createElement(
          FieldBox,
          { label: tool.name, valueClassName: "text-sm text-fg" },
          `${String(tool.count)} call${tool.count === 1 ? "" : "s"}${
            tool.errors > 0 ? `, ${String(tool.errors)} failed` : ""
          }`
        )
      )
    )
  );
}

/**
 * The one badge the list and the detail page both use for a server's
 * connection, so the two surfaces cannot drift into different verdicts.
 */
export function McpConnectionBadge({
  evidence
}: {
  readonly evidence: ControlApiMcpRuntimeEvidence | null;
}): React.JSX.Element {
  return React.createElement(StatusBadge, {
    status: evidence
      ? runtimeHealthStatus(evidence.health)
      : NOT_OBSERVED_STATUS,
    ...(evidence ? { label: `Runtime health: ${evidence.health}` } : {})
  });
}
