import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import {
  type PromptHistoryState,
  promptHistoryState
} from "../../../src/features/prompts/history-state.ts";
import {
  PromptDetailView,
  type PromptSaveOutcome
} from "../../../src/features/prompts/PromptDetailView.ts";
import { editorBaseRevisionFromQuery } from "../../../src/lib/server/canonical-source.ts";
import {
  controlApiFailureCode,
  fetchPromptDetail,
  fetchPromptVersion,
  fetchPromptVersions
} from "../../../src/lib/server/control-api.ts";
import {
  historyOffsetFromQuery,
  promptVersionSelection
} from "../../../src/lib/server/prompt-history.ts";
import { promptDocumentFromControlApi } from "../../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.ts";

export const dynamic = "force-dynamic";

const GIT_REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

const UNAVAILABLE_PROMPT_HISTORY: PromptHistoryState = {
  status: "unavailable",
  message: "Committed version history is only available for RuleSync commands."
};

function promptSaveOutcome(
  value: string | readonly string[] | undefined
): PromptSaveOutcome | undefined {
  const outcome = typeof value === "string" ? value : value?.[0];
  return outcome === "conflict" ||
    outcome === "validation" ||
    outcome === "apply-failed" ||
    outcome === "failed"
    ? outcome
    : undefined;
}

/**
 * The resource's own name, taken from the route parameter rather than from a
 * second fetch of the resource. The page body already reads the same
 * parameter, and a metadata function that fetched would double every
 * detail-page request.
 */
export async function generateMetadata({
  params
}: {
  readonly params: Promise<{ readonly name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Prompts` };
}

export default async function PromptDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly name: string }>;
  readonly searchParams?: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const [{ name }, query] = await Promise.all([
    params,
    searchParams ??
      Promise.resolve(
        {} as Record<string, string | readonly string[] | undefined>
      )
  ]);
  const saveOutcome = promptSaveOutcome(query.save);
  const { section, config } = readNodeContext("/prompts");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("canonical prompt content")
    );
  }

  const result = await fetchPromptDetail(name, config);
  if (result.kind === "http-error" && result.status === 404) notFound();
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Prompt source could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }

  const prompt = promptDocumentFromControlApi(result.data);
  const requestedRevision = query.revision;
  const shouldFetchVersion =
    prompt.kind === "command" &&
    typeof requestedRevision === "string" &&
    GIT_REVISION_PATTERN.test(requestedRevision);
  const [versionsResult, versionResult] = await Promise.all([
    prompt.kind === "command"
      ? fetchPromptVersions(
          prompt.name,
          config,
          {},
          historyOffsetFromQuery(query.historyOffset)
        )
      : Promise.resolve(null),
    shouldFetchVersion
      ? fetchPromptVersion(prompt.name, requestedRevision, config)
      : Promise.resolve(null)
  ]);
  const history =
    prompt.kind === "command" && versionsResult !== null
      ? promptHistoryState(
          versionsResult.kind === "ok" ? versionsResult.data : null
        )
      : UNAVAILABLE_PROMPT_HISTORY;
  const selection =
    prompt.kind === "command"
      ? promptVersionSelection(prompt.name, requestedRevision, versionResult)
      : {};
  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(PromptDetailView, {
      prompt,
      reconciliation: result.data.reconciliation,
      history,
      // The editor writes against the revision its content is based on. A
      // refused write leaves the browser holding the operator's edit, so the
      // page keeps the revision that edit was written for rather than the
      // revision the source has moved to.
      editorRevision:
        editorBaseRevisionFromQuery(query.based) ?? result.data.revision,
      ...(selection.selectedVersion
        ? { selectedVersion: selection.selectedVersion }
        : {}),
      ...(selection.error ? { versionSelectionError: selection.error } : {}),
      ...(saveOutcome ? { saveOutcome } : {})
    })
  );
}
