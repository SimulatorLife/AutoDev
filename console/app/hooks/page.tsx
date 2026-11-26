import type { Metadata } from "next";
import React from "react";

import { HooksView } from "../../src/features/hooks/HooksView.ts";
import {
  controlApiFailureCode,
  fetchHooks,
  fetchHooksApplied
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
  // The applied read is a separate question from the declaration, and a
  // failure to read it is not a failure to read the declaration: the page
  // shows the declaration and says the applied state was not observed. The
  // reason the read failed travels with it, because a gap on the page with no
  // explanation for it is a question the operator cannot answer.
  const appliedResult = await fetchHooksApplied(config);
  const applied = appliedResult.kind === "ok" ? appliedResult.data : null;
  const appliedUnavailable =
    appliedResult.kind === "ok"
      ? null
      : {
          code: controlApiFailureCode(appliedResult),
          message: appliedResult.message
        };
  const hooks = hooksFromControlApi(result.data);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      // The badge counts the declared events, and it is a count only when the
      // declaration was read. An invalid or unreadable source publishes an
      // empty list, and a badge with that list's length would claim the target
      // declares no hooks -- which is a claim about the read, not about the
      // target. A badge with no number says the count is not known.
      ...(result.data.valid === true ? { counts: { Hooks: hooks.length } } : {})
    },
    React.createElement(HooksView, {
      hooks,
      sourceValidity: result.data.valid,
      // Carried straight through: the page renders what the Runtime located in
      // the canonical source rather than re-deriving a reason from the flag.
      validationIssues: result.data.issues,
      revision: result.data.revision,
      applied,
      ...(appliedUnavailable === null ? {} : { appliedUnavailable })
    })
  );
}
