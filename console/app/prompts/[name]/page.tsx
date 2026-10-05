import { notFound } from "next/navigation";
import React from "react";

import type { ControlApiPromptVersionResponse } from "@simulatorlife/autodev-core";

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
  let history: PromptHistoryState = {
    status: "unavailable",
    message:
      "Committed version history is only available for RuleSync commands."
  };
  let selectedVersion: ControlApiPromptVersionResponse | undefined;
  let versionSelectionError: string | undefined;

  if (prompt.kind === "command") {
    const historyResult = await fetchPromptVersions(prompt.name, config);
    if (historyResult.kind === "ok") {
      history =
        historyResult.data.status === "available"
          ? {
              status: "available",
              versions: historyResult.data.versions,
              hasMore: historyResult.data.hasMore
            }
          : {
              status: "unavailable",
              message:
                "Git history is unavailable for this repository; the canonical working-tree source remains available."
            };
    } else {
      history = {
        status: "unavailable",
        message:
          "Committed version history could not be loaded; the canonical working-tree source remains available."
      };
    }

    const requestedRevision = query.revision;
    if (requestedRevision !== undefined) {
      if (
        typeof requestedRevision !== "string" ||
        !GIT_REVISION_PATTERN.test(requestedRevision)
      ) {
        versionSelectionError = "Select one valid committed prompt revision.";
      } else if (
        history.status !== "available" ||
        !history.versions.some(
          (version) => version.versionHash === requestedRevision
        )
      ) {
        versionSelectionError =
          "That revision is not in the available recent history for this command.";
      } else {
        const selected = await fetchPromptVersion(
          prompt.name,
          requestedRevision,
          config
        );
        if (
          selected.kind === "ok" &&
          selected.data.name === prompt.name &&
          selected.data.versionHash === requestedRevision
        ) {
          selectedVersion = selected.data;
        } else {
          versionSelectionError =
            "The selected committed version could not be loaded; the current source is unchanged.";
        }
      }
    }
  }

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(PromptDetailView, {
      prompt,
      history,
      ...(selectedVersion ? { selectedVersion } : {}),
      ...(versionSelectionError ? { versionSelectionError } : {}),
      ...(saveOutcome ? { saveOutcome } : {})
    })
  );
}
