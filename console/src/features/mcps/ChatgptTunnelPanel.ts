import type { ChatgptTunnelStatus } from "@simulatorlife/autodev-core";
import React from "react";
import { Button } from "../../components/forms/Button.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";

const action = "/api/chatgpt-tunnel";
export function ChatgptTunnelPanel({ status }: { status: ChatgptTunnelStatus | null }): React.JSX.Element {
  const hidden = (name: string, value: string) => React.createElement("input", { type: "hidden", name, value });
  const form = (operation: string, label: string, children: React.ReactNode[] = []) =>
    React.createElement("form", { method: "POST", action, className: "flex flex-col gap-2", key: operation },
      hidden("action", operation), hidden("expectedRevision", status?.revision ?? ""),
      ...children, React.createElement(Button, { type: "submit", variant: operation === "forget" ? "destructive" : "secondary" }, label));
  return React.createElement("section", { className: "flex flex-col gap-3 rounded border border-border p-4", "aria-label": "ChatGPT secure MCP tunnel" },
    React.createElement("h2", { className: SECTION_HEADING_CLASS }, "ChatGPT Secure MCP Tunnel"),
    React.createElement("p", null, !status ? "Tunnel status unavailable." : !status.configured ? "Not configured. Run scripts/install.sh --enable-chatgpt-tunnel with authorized OpenAI credentials." : status.enabled ? status.ready ? "Ready" : "Enabled, not ready" : "Disabled"),
    status?.configured ? React.createElement(React.Fragment, null,
      React.createElement("p", null, "Tunnel: " + status.tunnelId),
      React.createElement("p", null, "Effective role: " + status.role),
      form(status.enabled ? "disable" : "enable", status.enabled ? "Disconnect and disable" : "Enable"),
      form("configure", "Apply role grants and connect", [
        React.createElement("label", { key: "workspace" }, "Workspace",
          React.createElement("input", { name: "workspace", required: true, defaultValue: status.workspace ?? "", className: "block w-full border border-border rounded p-2" })),
        React.createElement("label", { key: "role" }, "Agent role",
          React.createElement("select", { name: "role", defaultValue: status.role, className: "block w-full border border-border rounded p-2" },
            ...(status.availableRoles?.length ? status.availableRoles : [status.role]).map(roleOption =>
              React.createElement("option", { key: roleOption, value: roleOption }, roleOption)))),
        ...Object.entries(status.reviewed).map(([server, tools]) =>
          React.createElement("fieldset", { key: server, className: "flex flex-col gap-1" },
            React.createElement("legend", null, server),
            ...tools.map(tool => React.createElement("label", { key: tool, className: "flex items-center gap-2" },
              React.createElement("input", { type: "checkbox", name: "grant", value: server + ":" + tool, defaultChecked: status.grants[server]?.includes(tool) ?? false }), tool))))
      ]),
      form("rotate", "Rotate local runtime credential and connect", [
        React.createElement("label", { key: "key" }, "New restricted runtime API key",
          React.createElement("input", { name: "runtimeKey", type: "password", autoComplete: "off", required: true, className: "block w-full border border-border rounded p-2" }))
      ]),
      form("forget", "Disable and forget local credential"),
      React.createElement("p", null, "For remote revocation, revoke the key or tunnel in OpenAI Platform. Local controls never accept an administrator key.")
    ) : null
  );
}
