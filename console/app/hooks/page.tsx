import type { Metadata } from "next";
import React from "react";

import { hookSaveOutcomeFromQuery } from "../../src/features/hooks/declaration.ts";
import { HooksView } from "../../src/features/hooks/HooksView.ts";
import { editorBaseRevisionFromQuery } from "../../src/lib/server/canonical-source.ts";
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

function firstSearchParam(
  raw: string | string[] | undefined
): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function HooksPage({
  searchParams
}: {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const resolvedSearchParams = searchParams
    ? await searchParams
    : ({} as Record<string, string | string[] | undefined>);
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
  const saveOutcome = hookSaveOutcomeFromQuery(resolvedSearchParams.save);
  const basedOn = editorBaseRevisionFromQuery(resolvedSearchParams.based);
  // The event the last write was about. It is resolved against the declared
  // events rather than taken on trust: a query value that names an event this
  // target does not declare is not an event, and the notice then says what it
  // can without it.
  const savedEvent = hooks.find(
    (hook) => hook.event === firstSearchParam(resolvedSearchParams.event)
  )?.event;
  return React.createElement(
    ConsolePageShell,
    {
      section,
      counts: { Hooks: hooks.length }
    },
    React.createElement(HooksView, {
      hooks,
      sourceValidity: result.data.valid,
      // Carried straight through: the page renders what the Runtime located in
      // the canonical source rather than re-deriving a reason from the flag.
      validationIssues: result.data.issues,
      revision: result.data.revision,
      // A refused write leaves the editor based on the revision it was filled
      // from, so the operator's edit is not silently paired with a
      // declaration that has since moved.
      ...(basedOn === undefined ? {} : { editorRevision: basedOn }),
      applied,
      ...(appliedUnavailable === null ? {} : { appliedUnavailable }),
      ...(saveOutcome === undefined ? {} : { saveOutcome }),
      ...(savedEvent === undefined ? {} : { savedEvent })
    })
  );
}
