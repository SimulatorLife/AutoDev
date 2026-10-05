import React from "react";

import { HooksView } from "../../src/features/hooks/HooksView.ts";
import {
  controlApiFailureCode,
  fetchHooks,
  readControlApiConfig
} from "../../src/lib/server/control-api.ts";
import { hooksFromControlApi } from "../../src/lib/server/views.ts";
import { ResourceUnavailable } from "../_console.tsx";

export const dynamic = "force-dynamic";

export default async function HooksPage(): Promise<React.JSX.Element> {
  const config = readControlApiConfig();
  if (!config) {
    return React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read hook configuration."
    });
  }
  const result = await fetchHooks(config);
  if (result.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "Hooks could not be loaded",
      code: controlApiFailureCode(result),
      message: result.message
    });
  }
  const hooks = hooksFromControlApi(result.data);
  return React.createElement(HooksView, {
    hooks,
    sourceValidity: result.data.valid
  });
}
