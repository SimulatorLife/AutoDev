import type { ControlApiPromptVersionResponse } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import {
  PromptDetailView,
  type PromptHistoryState,
  type PromptSaveOutcome
} from "../../../src/features/prompts/PromptDetailView.ts";
import {
  controlApiFailureCode,
  fetchPromptDetail,
  fetchPromptVersion,
  fetchPromptVersions
} from "../../../src/lib/server/control-api.ts";
import { promptDocumentFromControlApi } from "../../../src/lib/server/views.ts";
import {
  ConsolePageShell,
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

async function promptVersionSelection(
  name: string,
  requestedRevision: string | readonly string[] | undefined,
  history: PromptHistoryState,
  config: NonNullable<ReturnType<typeof readNodeContext>["config"]>
): Promise<{
  readonly selectedVersion?: ControlApiPromptVersionResponse;
  readonly error?: string;
}> {
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

  const result = await fetchPromptVersion(name, requestedRevision, config);
  if (
    result.kind === "ok" &&
    result.data.name === name &&
    result.data.versionHash === requestedRevision
  ) {
    return { selectedVersion: result.data };
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
  const saveOutcome = promptSaveOutcome(query.save);
  const { section, config } = readNodeContext("/prompts");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read canonical prompt content."
      })
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
  const history =
    prompt.kind === "command"
      ? promptHistoryState(await fetchPromptVersions(prompt.name, config))
      : UNAVAILABLE_PROMPT_HISTORY;
  const selection =
    prompt.kind === "command"
      ? await promptVersionSelection(
          prompt.name,
          query.revision,
          history,
          config
        )
      : {};
  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(PromptDetailView, {
      prompt,
      reconciliation: result.data.reconciliation,
      history,
      ...(selection.selectedVersion
        ? { selectedVersion: selection.selectedVersion }
        : {}),
      ...(selection.error ? { versionSelectionError: selection.error } : {}),
      ...(saveOutcome ? { saveOutcome } : {})
    })
  );
}
