import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
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
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Hooks"
};

export default function HooksPage(): React.JSX.Element {
  const { section, config } = readNodeContext("/hooks");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("hook configuration")
    );
  }
  // The read starts here and is not awaited: the page's own boundary keeps
  // the pending shell on screen while the Runtime is asked for its answer.
  const hooks = fetchHooks(config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(HooksContent, { section, hooks })
  );
}

/**
 * The hooks the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, below the page's own pending boundary, so the
 * pending shell is already on screen while it is on its way.
 */
async function HooksContent({
  section,
  hooks: hooksPromise
}: {
  readonly section: CanonicalNavSection;
  readonly hooks: Promise<Awaited<ReturnType<typeof fetchHooks>>>;
}): Promise<React.JSX.Element> {
  const result = await hooksPromise;
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
    {
      section,
      description:
        "Canonical RuleSync lifecycle hook declarations, matchers, and target projections.",
      counts: { Hooks: hooks.length }
    },
    React.createElement(HooksView, {
      hooks,
      sourceValidity: result.data.valid,
      // Carried straight through: the page renders what the Runtime located in
      // the canonical source rather than re-deriving a reason from the flag.
      validationIssues: result.data.issues
    })
  );
}
