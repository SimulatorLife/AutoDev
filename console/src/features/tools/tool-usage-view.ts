import React from "react";

import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { FieldBox } from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import {
  ACTION_LINK_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { type ToolUsageState } from "./tool-usage.ts";

function formatCount(value: number | null): string {
  return value === null
    ? NOT_OBSERVED_LABEL
    : new Intl.NumberFormat("en-US").format(value);
}

/**
 * The tool's historical use evidence.
 *
 * The view renders a state; it does not read it. The read is the browser's
 * and it happens after the page has rendered, because the twenty-four hour
 * telemetry aggregation is the most expensive read the Console makes and it
 * answers a question about one panel rather than about the page.
 */
export function toolUsageView({
  state,
  usageLink
}: {
  readonly state: ToolUsageState;
  readonly usageLink: string;
}): React.JSX.Element {
  // All the outcomes end with the same way through to the Usage telemetry
  // surface -- that is the one thing an operator can do about all of them --
  // so the link is built once instead of being re-spelled per branch, where
  // several copies could drift and two of them would be wrong without
  // anything saying so.
  const openUsage = React.createElement(
    NavigationLink,
    {
      href: usageLink,
      className: `text-xs ${ACTION_LINK_CLASS}`
    },
    "Open Usage →"
  );

  if (state.kind === "pending") {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-2", "aria-busy": "true" },
      React.createElement(StatusBadge, {
        status: "pending",
        label: "Usage evidence pending"
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "The Usage telemetry read has not answered yet; the call count is not rendered as zero."
      ),
      openUsage
    );
  }
  if (state.kind === "unavailable") {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(StatusBadge, {
        status: "unavailable",
        label: "Usage telemetry unavailable"
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "The dedicated read-only Usage telemetry path returned an error; per-tool use/error evidence stays unobserved."
      ),
      openUsage
    );
  }
  if (state.kind === "not-configured") {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(StatusBadge, {
        status: "unavailable",
        label: "Usage telemetry not configured"
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "The Usage telemetry credential is not configured on the Console server; per-tool use evidence stays unobserved."
      ),
      openUsage
    );
  }
  if (state.kind === "not-observed") {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: "No recorded tool calls"
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "No calls were observed for this tool through the dedicated read-only Usage path; the count is not rendered as zero."
      ),
      openUsage
    );
  }
  return React.createElement(
    "div",
    { className: "flex flex-col gap-3" },
    React.createElement(
      "dl",
      { className: "flex items-center gap-3" },
      React.createElement(
        FieldBox,
        { label: "Calls (24h)" },
        formatCount(state.calls)
      ),
      React.createElement(
        FieldBox,
        { label: "Errors (24h)" },
        NOT_OBSERVED_LABEL
      )
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      "Errors are reported only when the canonical Usage telemetry path exposes per-tool error counts. The Tools catalog never invents a value."
    ),
    openUsage
  );
}
