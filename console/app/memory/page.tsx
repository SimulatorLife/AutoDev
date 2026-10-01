import React from "react";

import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.tsx";

export const dynamic = "force-dynamic";

/**
 * Memory resource view.
 *
 * The retained OpenLIT memory/connector adapter is not yet wired into the
 * AutoDev Control API; this route therefore reports an explicit unavailable
 * state rather than fabricating connector-backed records.
 */
export default function MemoryPage(): React.JSX.Element {
  const { section, config } = readNodeContext("/memory");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read memory connectors."
      })
    );
  }
  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(ResourceUnavailable, {
      title: "Memory adapters are not wired into the Console",
      code: "autodev_memory_adapter_pending",
      message:
        "The retained OpenLIT memory connector adapter has not yet been integrated with the Control API.",
      hint: "Once the connector adapter exists, Memory will list records scoped to the current AutoDev workspace."
    })
  );
}
