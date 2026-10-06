import type { ControlApiPromptVersionResponse } from "@simulatorlife/autodev-core";
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
  fetchPromptVersions,
  readControlApiConfig
} from "../../../src/lib/server/control-api.ts";
import { promptDocumentFromControlApi } from "../../../src/lib/server/views.ts";
import { ResourceUnavailable } from "../../_console.ts";

export const dynamic = "force-dynamic";

type PromptDetailSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

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

function requestedRevisionOf(
  requestedRevision: string | readonly string[] | undefined
): string | null {
  return typeof requestedRevision === "string" &&
    GIT_REVISION_PATTERN.test(requestedRevision)
    ? requestedRevision
    : null;
}

/**
 * The requested committed version, shown only when it is in the listed
 * recent history and its read returned that exact version.
 */
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
  const revision = requestedRevisionOf(requestedRevision);
  if (revision === null) {
    return { error: "Select one valid committed prompt revision." };
  }
  if (
    history.status !== "available" ||
    !history.versions.some((version) => version.versionHash === revision)
  ) {
    return {
      error:
        "That revision is not in the available recent history for this command."
    };
  }
  if (
    versionResult?.kind === "ok" &&
    versionResult.data.name === name &&
    versionResult.data.versionHash === revision
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

export default async function PromptDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly name: string }>;
  readonly searchParams?: Promise<PromptDetailSearchParams>;
}): Promise<React.JSX.Element> {
  const [{ name }, query] = await Promise.all([
    params,
    searchParams ?? Promise.resolve<PromptDetailSearchParams>({})
  ]);
  const saveOutcome = promptSaveOutcome(query.save);
  const config = readControlApiConfig();
  if (!config) {
    return React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read canonical prompt content."
    });
  }

  // The committed history and a requested version depend only on the URL, so
  // they load alongside the prompt instead of after it. They are used only
  // for a RuleSync command, and a requested version only once the history
  // lists it.
  const requestedRevision = requestedRevisionOf(query.revision);
  const [result, versionsResult, versionResult] = await Promise.all([
    fetchPromptDetail(name, config),
    fetchPromptVersions(name, config),
    requestedRevision === null
      ? null
      : fetchPromptVersion(name, requestedRevision, config)
  ]);
  if (result.kind === "http-error" && result.status === 404) notFound();
  if (result.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "Prompt source could not be loaded",
      code: controlApiFailureCode(result),
      message: result.message
    });
  }

  const prompt = promptDocumentFromControlApi(result.data);
  const history =
    prompt.kind === "command"
      ? promptHistoryState(versionsResult)
      : UNAVAILABLE_PROMPT_HISTORY;
  const selection =
    prompt.kind === "command"
      ? promptVersionSelection(
          prompt.name,
          query.revision,
          history,
          versionResult
        )
      : {};
  return React.createElement(PromptDetailView, {
    prompt,
    history,
    ...(selection.selectedVersion
      ? { selectedVersion: selection.selectedVersion }
      : {}),
    ...(selection.error ? { versionSelectionError: selection.error } : {}),
    ...(saveOutcome ? { saveOutcome } : {})
  });
}
