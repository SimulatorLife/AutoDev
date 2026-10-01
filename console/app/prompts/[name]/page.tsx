import { notFound } from "next/navigation";
import React from "react";

import { PromptDetailView } from "../../../src/features/prompts/PromptDetailView.ts";
import {
  controlApiFailureCode,
  fetchPromptDetail
} from "../../../src/lib/server/control-api.ts";
import { promptDocumentFromControlApi } from "../../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.tsx";

export const dynamic = "force-dynamic";

export default async function PromptDetailPage({
  params
}: {
  readonly params: Promise<{ readonly name: string }>;
}): Promise<React.JSX.Element> {
  const { name } = await params;
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

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(PromptDetailView, {
      prompt: promptDocumentFromControlApi(result.data)
    })
  );
}
