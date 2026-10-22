import type { ControlApiMcpAppliedResponse } from "@simulatorlife/autodev-core";
import React from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { FieldBox } from "../../components/panels/DetailGrid.ts";
import { ReconciliationPanel } from "../../components/status/ConvergenceBadge.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

/**
 * The MCP configuration the Runtime applied, and how it compares with the
 * canonical declaration.
 *
 * The declaration says what the operator asked for and the applied projection
 * says what the Runtime published; the two are different readings, and the
 * reconciliation between them is the Runtime's own verdict. The Console
 * renders it rather than deriving one.
 *
 * A configuration that was never applied is not a failure: the Runtime has
 * published nothing yet, and the page says so instead of showing an empty
 * configuration that reads like an applied one.
 */
export function McpAppliedConfiguration({
  applied,
  serverName
}: {
  readonly applied: ControlApiMcpAppliedResponse | null;
  readonly serverName: string;
}): React.JSX.Element {
  if (!applied) {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: "Applied configuration: Not observed"
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "The Runtime's applied MCP configuration could not be read, so nothing is claimed about what it published."
      )
    );
  }

  const server = applied.servers.find((entry) => entry.name === serverName);
  return React.createElement(
    "div",
    { className: "flex flex-col gap-3" },
    React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(
        "h4",
        { className: SECTION_HEADING_CLASS },
        "Applied configuration"
      ),
      applied.available
        ? React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            `The Runtime published this MCP configuration for the "${applied.target}" target from ${applied.source}.`
          )
        : React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            "The Runtime has published no MCP configuration on this machine yet."
          ),
      server
        ? React.createElement(
            "dl",
            { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
            // The labels name the applied configuration, because the panel
            // above it labels the declaration's fields with the same names:
            // "Command" on its own would not say which of the two it is.
            React.createElement(
              FieldBox,
              { label: "Applied command" },
              server.command ?? NOT_OBSERVED_LABEL
            ),
            React.createElement(
              FieldBox,
              { label: "Applied arguments" },
              server.args.length > 0
                ? server.args.join(" ")
                : NOT_OBSERVED_LABEL
            ),
            React.createElement(
              FieldBox,
              { label: "Applied endpoint URL" },
              server.url ?? NOT_OBSERVED_LABEL
            ),
            React.createElement(
              FieldBox,
              { label: "Applied working directory" },
              server.cwd ?? NOT_OBSERVED_LABEL
            ),
            React.createElement(
              FieldBox,
              { label: "Applied bearer token environment variable" },
              server.bearerTokenEnvVar ?? NOT_OBSERVED_LABEL
            )
          )
        : React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            "This server is not in the configuration the Runtime published."
          )
    ),
    React.createElement(ReconciliationPanel, {
      status: applied.reconciliation.status,
      history: applied.reconciliation.history
    })
  );
}
