import { notFound } from "next/navigation";
import React from "react";

import {
  PromptDetailView,
  type PromptSaveOutcome
} from "../../../src/features/prompts/PromptDetailView.ts";
import {
  controlApiFailureCode,
  fetchPromptDetail,
  readControlApiConfig
} from "../../../src/lib/server/control-api.ts";
import { promptDocumentFromControlApi } from "../../../src/lib/server/views.ts";
import { ResourceUnavailable } from "../../_console.ts";

export const dynamic = "force-dynamic";

type PromptDetailSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

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

  const result = await fetchPromptDetail(name, config);
  if (result.kind === "http-error" && result.status === 404) notFound();
  if (result.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "Prompt source could not be loaded",
      code: controlApiFailureCode(result),
      message: result.message
    });
  }

  return React.createElement(PromptDetailView, {
    prompt: promptDocumentFromControlApi(result.data),
    ...(saveOutcome ? { saveOutcome } : {})
  });
}
