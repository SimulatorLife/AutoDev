import type { PlaytestLaunchIntent } from "@simulatorlife/autodev-data/playtesting";

import type { PlaytestLaunchIntentRepository } from "../../src/playtesting/mcp.ts";

/** In-memory launch intent store for tests; production always injects Data's durable ClickHouse owner. */
export function inMemoryPlaytestLaunchIntentRepository(): PlaytestLaunchIntentRepository {
  const intents = new Map<string, PlaytestLaunchIntent>();
  const key = (workspaceId: string, actorId: string, requestId: string) =>
    JSON.stringify([workspaceId, actorId, requestId]);
  return {
    async getLaunchIntent(workspaceId, actorId, requestId) {
      return intents.get(key(workspaceId, actorId, requestId)) ?? null;
    },
    async insertLaunchIntent(intent) {
      const identity = key(
        intent.workspaceId,
        intent.actorId,
        intent.requestId
      );
      const previous = intents.get(identity);
      if (
        previous &&
        (previous.launchIntentHash !== intent.launchIntentHash ||
          previous.batchId !== intent.batchId)
      ) {
        throw new Error("Conflicting in-memory launch intent.");
      }
      intents.set(identity, intent);
    }
  };
}
