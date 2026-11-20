import { NextResponse } from "next/server.js";

import {
  fetchAgents,
  fetchModels,
  fetchProviders,
  fetchWorkspaces
} from "../../../../src/lib/server/control-api.ts";
import { readNodeContext } from "../../../_console.ts";
import type { SearchSource } from "../../../../src/components/navigation/search-destinations.ts";

export const dynamic = "force-dynamic";

const RECORD_SOURCES = [
  "providers",
  "models",
  "agentRoles",
  "workspaces"
] as const;

/** Serialize canonical Control API records for the shared client-side search. */
export async function GET(): Promise<NextResponse> {
  try {
    const { config } = readNodeContext("/providers");
    if (config === null) {
      return NextResponse.json(
        {
          unavailableSources: ["configuration", ...RECORD_SOURCES]
        } satisfies { readonly unavailableSources: readonly SearchSource[] },
        { status: 503 }
      );
    }
    const [providers, models, agents, workspaces] = await Promise.all([
      fetchProviders(config),
      fetchModels(config),
      fetchAgents(config),
      fetchWorkspaces(config)
    ]);
    const unavailableSources: SearchSource[] = [];
    if (providers.kind !== "ok") unavailableSources.push("providers");
    if (models.kind !== "ok") unavailableSources.push("models");
    if (agents.kind !== "ok") unavailableSources.push("agentRoles");
    if (workspaces.kind !== "ok") unavailableSources.push("workspaces");
    const successfulReads = 4 - unavailableSources.length;
    return NextResponse.json(
      {
        ...(providers.kind === "ok" ? { providers: providers.data } : {}),
        ...(models.kind === "ok" ? { models: models.data } : {}),
        ...(agents.kind === "ok" ? { agents: agents.data } : {}),
        ...(workspaces.kind === "ok" ? { workspaces: workspaces.data } : {}),
        unavailableSources
      },
      { status: successfulReads === 0 ? 503 : 200 }
    );
  } catch {
    return NextResponse.json(
      { unavailableSources: ["endpoint", ...RECORD_SOURCES] },
      { status: 503 }
    );
  }
}
