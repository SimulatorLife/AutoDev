import type {
  CanonicalNavSection,
  ControlApiPromptVersionResponse
} from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import {
  PromptDetailView,
  type PromptHistoryState,
  type PromptSaveOutcome
} from "../../../src/features/prompts/PromptDetailView.ts";
import { editorBaseRevisionFromQuery } from "../../../src/lib/server/canonical-source.ts";
import {
  type ControlApiConfig,
  controlApiFailureCode,
  fetchPromptDetail,
  fetchPromptVersion,
  fetchPromptVersions
} from "../../../src/lib/server/control-api.ts";
import { promptDocumentFromControlApi } from "../../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
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

function promptHistoryState(
  result: Awaited<ReturnType<typeof fetchPromptVersions>>
): PromptHistoryState {
  if (result.kind !== "ok") {
    return {
      status: "unavailable",
      message:
        "Committed version history could not be loaded; the canonical working-tree source remains available."
    };
  }
  if (result.data.status === "unavailable") {
    return {
      status: "unavailable",
      message:
        "Git history is unavailable for this repository; the canonical working-tree source remains available."
    };
  }
  return {
    status: "available",
    versions: result.data.versions,
    hasMore: result.data.hasMore
  };
}

function promptVersionSelection(
  name: string,
  requestedRevision: string | readonly string[] | undefined,
  history: PromptHistoryState,
  versionResult: Awaited<ReturnType<typeof fetchPromptVersion>> | null
): {
  readonly selectedVersion?: ControlApiPromptVersionResponse;
  readonly error?: string;
} {
  if (requestedRevision === undefined) return {};
  if (
    typeof requestedRevision !== "string" ||
    !GIT_REVISION_PATTERN.test(requestedRevision)
  ) {
    return { error: "Select one valid committed prompt revision." };
  }
  if (
    history.status !== "available" ||
    !history.versions.some(
      (version) => version.versionHash === requestedRevision
    )
  ) {
    return {
      error:
        "That revision is not in the available recent history for this command."
    };
  }

  if (
    versionResult?.kind === "ok" &&
    versionResult.data.name === name &&
    versionResult.data.versionHash === requestedRevision
  ) {
    return { selectedVersion: versionResult.data };
  }
  return {
    error:
      "The selected committed version could not be loaded; the current source is unchanged."
  };
}

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
  const { section, config } = readNodeContext("/prompts");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("canonical prompt content")
    );
  }

  // The read starts here and is not awaited.
  const result = fetchPromptDetail(name, config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(PromptDetailContent, {
      section,
      result,
      config,
      query
    })
  );
}

/**
 * The prompt the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, inside the page's own pending boundary. The
 * version-history read follows this one because it is keyed on the prompt this
 * read names: a command prompt has a history and a role prompt does not.
 */
async function PromptDetailContent({
  section,
  result,
  config,
  query
}: {
  readonly section: CanonicalNavSection;
  readonly result: Promise<Awaited<ReturnType<typeof fetchPromptDetail>>>;
  readonly config: ControlApiConfig;
  readonly query: Record<string, string | readonly string[] | undefined>;
}): Promise<React.JSX.Element> {
  const settled = await result;
  if (settled.kind === "http-error" && settled.status === 404) notFound();
  if (settled.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Prompt source could not be loaded",
        code: controlApiFailureCode(settled),
        message: settled.message
      })
    );
  }

  const prompt = promptDocumentFromControlApi(settled.data);
  const requestedRevision = query.revision;
  const shouldFetchVersion =
    prompt.kind === "command" &&
    typeof requestedRevision === "string" &&
    GIT_REVISION_PATTERN.test(requestedRevision);
  const [versionsResult, versionResult] = await Promise.all([
    prompt.kind === "command"
      ? fetchPromptVersions(prompt.name, config)
      : Promise.resolve(null),
    shouldFetchVersion
      ? fetchPromptVersion(prompt.name, requestedRevision, config)
      : Promise.resolve(null)
  ]);
  const history =
    prompt.kind === "command" && versionsResult !== null
      ? promptHistoryState(versionsResult)
      : UNAVAILABLE_PROMPT_HISTORY;
  const selection =
    prompt.kind === "command"
      ? promptVersionSelection(
          prompt.name,
          requestedRevision,
          history,
          versionResult
        )
      : {};
  const saveOutcome = promptSaveOutcome(query.save);
  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(PromptDetailView, {
      prompt,
      reconciliation: settled.data.reconciliation,
      history,
      // The editor writes against the revision its content is based on. A
      // refused write leaves the browser holding the operator's edit, so the
      // page keeps the revision that edit was written for rather than the
      // revision the source has moved to.
      editorRevision:
        editorBaseRevisionFromQuery(query.based) ?? settled.data.revision,
      ...(selection.selectedVersion
        ? { selectedVersion: selection.selectedVersion }
        : {}),
      ...(selection.error ? { versionSelectionError: selection.error } : {}),
      ...(saveOutcome ? { saveOutcome } : {})
    })
  );
}
