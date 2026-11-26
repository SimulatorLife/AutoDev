import type {
  ChatgptTunnelMutation,
  ChatgptTunnelStatus
} from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { DETAIL_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge,
  type StatusBadgeStatus
} from "../../components/status/StatusBadge.ts";
import { chipList } from "../../components/tables/Chips.ts";
import { MUTED_BODY_CLASS } from "../../components/ui/text-classes.ts";

/*
The optional ChatGPT tunnel: an authenticated external client of the shared
MCP gateway.

The panel carries only the tunnel's own lifecycle and credential controls
(enable, disable, rotate, forget), each a revision-checked Control API
mutation. Which roles the gateway publishes and which tools they may use are
repository-owned and shown read-only in the gateway panel; the tunnel has no
control that changes them.
*/

const action = "/api/chatgpt-tunnel";
const FIELD_CLASS = "block w-full rounded border border-border p-2";

type TunnelAction = ChatgptTunnelMutation["action"];

function tunnelStatus(status: ChatgptTunnelStatus | null): {
  readonly status: StatusBadgeStatus;
  readonly label: string;
} {
  if (status === null)
    return { status: NOT_OBSERVED_STATUS, label: NOT_OBSERVED_LABEL };
  if (!status.configured)
    return { status: "unavailable", label: "Not configured" };
  if (!status.enabled) return { status: "unavailable", label: "Disabled" };
  return status.ready
    ? { status: "ready", label: "Ready" }
    : { status: "error", label: "Enabled, not ready" };
}

function tunnelForm(
  revision: string,
  operation: TunnelAction,
  label: string,
  fields: readonly React.ReactNode[] = []
): React.ReactElement {
  return React.createElement(
    "form",
    {
      method: "POST",
      action,
      className: "flex flex-col gap-2",
      key: operation
    },
    React.createElement("input", {
      type: "hidden",
      name: "action",
      value: operation
    }),
    React.createElement("input", {
      type: "hidden",
      name: "expectedRevision",
      value: revision
    }),
    ...fields,
    React.createElement(
      Button,
      {
        type: "submit",
        variant: operation === "forget" ? "destructive" : "secondary"
      },
      label
    )
  );
}

function tunnelControls(status: ChatgptTunnelStatus): React.ReactElement {
  return React.createElement(
    "div",
    { className: "flex flex-col gap-4" },
    tunnelForm(
      status.revision,
      status.enabled ? "disable" : "enable",
      status.enabled ? "Disconnect and disable" : "Enable"
    ),
    tunnelForm(
      status.revision,
      "rotate",
      "Rotate local runtime credential and connect",
      [
        React.createElement(
          "label",
          { key: "runtimeKey", className: "flex flex-col gap-1" },
          "New restricted runtime API key",
          React.createElement("input", {
            name: "runtimeKey",
            type: "password",
            autoComplete: "off",
            required: true,
            className: FIELD_CLASS
          })
        )
      ]
    ),
    tunnelForm(
      status.revision,
      "forget",
      "Disable and forget local credential"
    ),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "For remote revocation, revoke the key or tunnel in OpenAI Platform. Local controls never accept an administrator key."
    )
  );
}

export function ChatgptTunnelPanel({
  status
}: {
  status: ChatgptTunnelStatus | null;
}): React.JSX.Element {
  const verdict = tunnelStatus(status);
  return React.createElement(
    "section",
    {
      className: `${DETAIL_PANEL_CLASS} flex flex-col gap-4`,
      "aria-labelledby": "chatgpt-tunnel-heading",
      "data-chatgpt-tunnel-status": verdict.label
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      React.createElement(
        "h2",
        { id: "chatgpt-tunnel-heading", className: SECTION_HEADING_CLASS },
        "ChatGPT Secure MCP Tunnel"
      ),
      React.createElement(StatusBadge, verdict)
    ),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "Optional external ingress. Disabling or losing it never affects local MCP access through the gateway."
    ),
    status === null
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          "Tunnel status is unavailable."
        )
      : status.configured
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(
              DetailGrid,
              { columns: 2 },
              React.createElement(
                DetailValue,
                { label: "Tunnel" },
                status.tunnelId ?? NOT_OBSERVED_LABEL
              ),
              React.createElement(
                DetailValue,
                { label: "Published channels", valueClassName: null },
                chipList({
                  items: status.roles,
                  emptyLabel: "No channel published",
                  testId: "chatgpt-tunnel-channels"
                })
              )
            ),
            tunnelControls(status)
          )
        : React.createElement(
            "p",
            { className: MUTED_BODY_CLASS },
            "Not configured. Run scripts/install.sh --enable-chatgpt-tunnel with authorized OpenAI credentials."
          )
  );
}
