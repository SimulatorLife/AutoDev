import type { Metadata } from "next";
import React from "react";

import { HooksView } from "../../src/features/hooks/HooksView.ts";
import {
  controlApiFailureCode,
  fetchHooks
} from "../../src/lib/server/control-api.ts";
import { hooksFromControlApi } from "../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Hooks"
};

export default async function HooksPage(): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/hooks");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("hook configuration")
    );
  }
  const result = await fetchHooks(config);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Hooks could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }
  const hooks = hooksFromControlApi(result.data);
  return React.createElement(
    ConsolePageShell,
    { section, counts: { Hooks: hooks.length } },
    React.createElement(HooksView, {
      hooks,
      sourceValidity: result.data.valid,
      // Carried straight through: the page renders what the Runtime located in
      // the canonical source rather than re-deriving a reason from the flag.
      validationIssues: result.data.issues
    })
  );
}
