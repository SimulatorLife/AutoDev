import React from "react";

import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.tsx";

export const dynamic = "force-dynamic";

/**
 * Tools resource view.
 *
 * The effective tool catalog is composed from native, MCP, plugin, permission,
 * runtime-availability, and usage sources. None of those adapters is yet wired
 * into the Console, so this route renders an explicit unavailable state
 * rather than emitting fabricated availability rows.
 */
export default function ToolsPage(): React.JSX.Element {
  const { section, config } = readNodeContext("/tools");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read tool catalog data."
      })
    );
  }
  return React.createElement(
    ConsolePageShell,
    { section, counts: { Tools: 0 } },
    React.createElement(ResourceUnavailable, {
      title: "Tool catalog adapters are not wired into the Console",
      code: "autodev_tools_adapter_pending",
      message:
        "Native, MCP, plugin, permission, runtime-availability, and usage telemetry sources are not yet composed into a single catalog.",
      hint: "Once the effective catalog adapter exists, Tools will render the merged tool inventory."
    })
  );
}
