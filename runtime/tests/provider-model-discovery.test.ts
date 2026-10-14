import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverMiniMaxModels,
  parseAntigravityModelList,
  type ProviderModelDiscoveryAdapter,
  providerModelDiscoveryPersistenceSnapshot,
  ProviderModelDiscoveryService,
  restoreProviderModelDiscoveryPersistence
} from "../src/providers/model-discovery.ts";
import { RouterPersistence } from "../src/router/persistence/index.ts";
import { ROUTING_POLICY } from "../src/router/routing.ts";

const AGY_MODELS = [
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gpt-oss-120b-medium\tGPT OSS 120B (Medium)"
].join("\n");

test("agy model parsing preserves provider IDs and labels", () => {
  assert.deepEqual(parseAntigravityModelList(AGY_MODELS), [
    {
      id: "gemini-3.8-flash-low",
      displayName: "Gemini 3.8 Flash (Low)"
    },
    {
      id: "gpt-oss-120b-medium",
      displayName: "GPT OSS 120B (Medium)"
    }
  ]);
  assert.deepEqual(parseAntigravityModelList(""), []);
});

test("agy model parsing rejects malformed IDs and duplicates", () => {
  assert.throws(
    () => parseAntigravityModelList("invalid/id\tInvalid"),
    /invalid or duplicate model ID/u
  );
  assert.throws(
    () =>
      parseAntigravityModelList(
        "gemini-3.8-flash-low\tLow\ngemini-3.8-flash-low\tDuplicate"
      ),
    /invalid or duplicate model ID/u
  );
});

test("MiniMax model discovery uses its authenticated read-only listing endpoint", async () => {
  const requests: Array<{ url: string; authorization: string | undefined }> =
    [];
  const models = await discoverMiniMaxModels(
    { MINIMAX_API_KEY: "model-list-fixture-token" } as NodeJS.ProcessEnv,
    async (input, init) => {
      requests.push({
        url: String(input),
        authorization:
          new Headers(init?.headers).get("authorization") ?? undefined
      });
      return Response.json({
        object: "list",
        data: [
          { id: "MiniMax-M3", object: "model", owned_by: "minimax" },
          {
            id: "MiniMax-M3.1-Flash-Preview",
            object: "model",
            owned_by: "minimax"
          }
        ]
      });
    }
  );
  assert.deepEqual(models, [
    { id: "MiniMax-M3", displayName: null },
    { id: "MiniMax-M3.1-Flash-Preview", displayName: null }
  ]);
  assert.deepEqual(requests, [
    {
      url: "https://api.minimax.io/v1/models",
      authorization: "Bearer model-list-fixture-token"
    }
  ]);
});

test("MiniMax model discovery refuses a missing credential before network access", async () => {
  let called = false;
  await assert.rejects(
    discoverMiniMaxModels({} as NodeJS.ProcessEnv, async () => {
      called = true;
      return Response.json({ object: "list", data: [] });
    }),
    /MINIMAX_API_KEY is not configured/u
  );
  assert.equal(called, false);
});

test("MiniMax model discovery refuses malformed and oversized listings", async () => {
  const env = { MINIMAX_API_KEY: "fixture-token" } as NodeJS.ProcessEnv;
  await assert.rejects(
    discoverMiniMaxModels(env, async () =>
      Response.json({ object: "list", data: [{ id: "invalid/id" }] })
    ),
    /invalid or duplicate model ID/u
  );
  const oversized = new Response("x".repeat(256 * 1024 + 1), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  await assert.rejects(
    discoverMiniMaxModels(env, async () => oversized),
    /size bound/u
  );
});

test("discovery snapshots distinguish observed-empty, unavailable, and unsupported routes", async () => {
  let antigravityReads = 0;
  const observedAdapter: ProviderModelDiscoveryAdapter = {
    source: "fixture provider list",
    discover: async () => {
      antigravityReads += 1;
      return parseAntigravityModelList(AGY_MODELS);
    }
  };
  const emptyAdapter: ProviderModelDiscoveryAdapter = {
    source: "empty provider list",
    discover: async () => []
  };
  const minimaxAdapter: ProviderModelDiscoveryAdapter = {
    source: "fixture MiniMax API",
    discover: async () => [{ id: "MiniMax-M3", displayName: null }]
  };
  const service = new ProviderModelDiscoveryService({
    providerIds: () => ["antigravity", "claude", "minimax", "copilot"],
    adapters: {
      antigravity: observedAdapter,
      claude: emptyAdapter,
      minimax: minimaxAdapter
    },
    now: () => new Date("2026-10-14T12:00:00.000Z")
  });

  const beforeRefresh = service.snapshot();
  assert.equal(beforeRefresh.providers[0]?.discovery.status, "unavailable");
  assert.equal(beforeRefresh.providers[2]?.discovery.status, "unavailable");
  assert.equal(beforeRefresh.providers[3]?.discovery.status, "unavailable");
  assert.equal(
    antigravityReads,
    0,
    "reading the cached snapshot does not contact a provider"
  );

  await service.refresh();
  assert.equal(antigravityReads, 1);
  const afterRefresh = service.snapshot();
  const antigravity = afterRefresh.providers.find(
    (entry) => entry.provider === "antigravity"
  )?.discovery;
  const claude = afterRefresh.providers.find(
    (entry) => entry.provider === "claude"
  )?.discovery;
  const minimax = afterRefresh.providers.find(
    (entry) => entry.provider === "minimax"
  )?.discovery;

  assert.equal(antigravity?.status, "observed");
  if (antigravity?.status !== "observed") {
    assert.fail("the provider listing should be observed");
  }
  assert.deepEqual(
    antigravity.models.map((model) => [model.id, model.routeability.status]),
    [
      ["gemini-3.8-flash-low", "supported"],
      ["gpt-oss-120b-medium", "unsupported"]
    ]
  );
  assert.equal(claude?.status, "observed");
  if (claude?.status !== "observed") {
    assert.fail("an empty successful listing is an observation");
  }
  assert.deepEqual(claude.models, []);
  assert.equal(minimax?.status, "observed");
  if (minimax?.status !== "observed") {
    assert.fail("the provider listing should be observed");
  }
  assert.deepEqual(minimax.models, [
    {
      id: "MiniMax-M3",
      displayName: null,
      routeability: { status: "supported" }
    }
  ]);
  assert.equal(
    afterRefresh.providers.find((entry) => entry.provider === "copilot")
      ?.discovery.status,
    "unavailable"
  );
  service.stop();
  restoreProviderModelDiscoveryPersistence(null);
});

test("a failed refresh retains the last observed list as stale, not as current", async () => {
  let fail = false;
  const adapter: ProviderModelDiscoveryAdapter = {
    source: "fixture provider list",
    discover: async () => {
      if (fail) throw new Error("fixture failure");
      return parseAntigravityModelList(AGY_MODELS);
    }
  };
  let now = 0;
  const service = new ProviderModelDiscoveryService({
    providerIds: () => ["antigravity"],
    adapters: { antigravity: adapter },
    now: () => new Date(Date.UTC(2026, 9, 14, 12, 0, now++))
  });

  await service.refresh();
  fail = true;
  await service.refresh();

  const discovery = service.snapshot().providers[0]?.discovery;
  assert.equal(discovery?.status, "stale");
  if (discovery?.status !== "stale") {
    assert.fail(
      "a failed refresh after observation must retain a stale snapshot"
    );
  }
  assert.equal(discovery.observedAt, "2026-10-14T12:00:01.000Z");
  assert.equal(discovery.lastAttemptAt, "2026-10-14T12:00:02.000Z");
  assert.match(discovery.reason, /fixture failure/u);
  assert.equal(discovery.models.length, 2);
  service.stop();
  restoreProviderModelDiscoveryPersistence(null);
});

test("last-known provider models survive restart as stale until a fresh listing succeeds", async () => {
  const provider = "antigravity";
  const directory = mkdtempSync(
    join(tmpdir(), "autodev-provider-model-state-")
  );
  const stateFile = join(directory, "router-state.json");
  const previousPersistence = providerModelDiscoveryPersistenceSnapshot();
  const previousDiscovered = ROUTING_POLICY.discoveredModels()
    .filter((model) => model.provider === provider)
    .map(({ id, displayName, routeability }) => ({
      id,
      displayName,
      routeability
    }));
  restoreProviderModelDiscoveryPersistence(null);
  let writes = 0;
  const persistence = new RouterPersistence({
    stateFile,
    isMain: true,
    getSnapshot: () => ({
      providerModelDiscovery: providerModelDiscoveryPersistenceSnapshot()
    })
  });
  const observedAdapter: ProviderModelDiscoveryAdapter = {
    source: "fixture provider source",
    discover: async () => parseAntigravityModelList(AGY_MODELS)
  };
  const firstRuntime = new ProviderModelDiscoveryService({
    providerIds: () => [provider],
    adapters: { [provider]: observedAdapter },
    now: () => new Date("2026-10-14T12:00:00.000Z"),
    onSnapshotChanged: () => writes++
  });
  await firstRuntime.refresh();
  const persisted = providerModelDiscoveryPersistenceSnapshot();
  assert.equal(writes, 1);
  assert.match(JSON.stringify(persisted), /gemini-3.8-flash-low/u);
  assert.doesNotMatch(
    JSON.stringify(persisted),
    /routeability/u,
    "routeability must be recomputed from the current Runtime on restore"
  );
  assert.doesNotMatch(JSON.stringify(persisted), /MINIMAX_API_KEY|Bearer /u);
  assert.equal(await persistence.persistNow(), true);
  const serialized = JSON.parse(readFileSync(stateFile, "utf8")) as {
    providerModelDiscovery?: unknown;
  };
  assert.deepEqual(serialized.providerModelDiscovery, persisted);
  firstRuntime.stop();

  restoreProviderModelDiscoveryPersistence(null);
  const restoration = new RouterPersistence({
    stateFile,
    isMain: true,
    restoreSection: (section, value) => {
      if (section === "providerModelDiscovery") {
        assert.equal(restoreProviderModelDiscoveryPersistence(value), true);
      }
    }
  });
  assert.equal(restoration.load(), true);
  assert.deepEqual(providerModelDiscoveryPersistenceSnapshot(), persisted);
  const failedAdapter: ProviderModelDiscoveryAdapter = {
    source: "fixture provider source",
    discover: async () => {
      throw new Error("fixture refresh timeout");
    }
  };
  const restartedRuntime = new ProviderModelDiscoveryService({
    providerIds: () => [provider],
    adapters: { [provider]: failedAdapter },
    now: () => new Date("2026-10-14T12:15:00.000Z")
  });
  const restored = restartedRuntime.snapshot().providers[0]?.discovery;
  assert.equal(restored?.status, "stale");
  if (restored?.status !== "stale") {
    assert.fail(
      "a prior provider response must restore as stale, never observed"
    );
  }
  assert.equal(restored.observedAt, "2026-10-14T12:00:00.000Z");
  assert.match(restored.reason, /Runtime restarted/u);
  assert.deepEqual(
    restored.models.map(({ id, routeability }) => [id, routeability.status]),
    [
      ["gemini-3.8-flash-low", "supported"],
      ["gpt-oss-120b-medium", "unsupported"]
    ]
  );

  await restartedRuntime.refresh();
  const afterFailedRefresh =
    restartedRuntime.snapshot().providers[0]?.discovery;
  assert.equal(afterFailedRefresh?.status, "stale");
  if (afterFailedRefresh?.status === "stale") {
    assert.match(afterFailedRefresh.reason, /fixture refresh timeout/u);
    assert.equal(afterFailedRefresh.models.length, 2);
  }

  restartedRuntime.stop();
  restoreProviderModelDiscoveryPersistence(previousPersistence);
  ROUTING_POLICY.setDiscoveredProviderModels(provider, previousDiscovered);
  rmSync(directory, { recursive: true, force: true });
});

test("an invalid persisted model snapshot is discarded and remains unavailable", () => {
  const previousPersistence = providerModelDiscoveryPersistenceSnapshot();
  const previousDiscovered = ROUTING_POLICY.discoveredModels()
    .filter((model) => model.provider === "antigravity")
    .map(({ id, displayName, routeability }) => ({
      id,
      displayName,
      routeability
    }));
  assert.equal(
    restoreProviderModelDiscoveryPersistence({
      schema: "autodev-provider-model-discovery-state-v1",
      providers: [
        {
          provider: "antigravity",
          source: "fixture provider source",
          observedAt: "2026-10-14T12:00:00.000Z",
          lastAttemptAt: "2026-10-14T12:00:00.000Z",
          reason: null,
          models: [{ id: "invalid/model", displayName: null }]
        }
      ]
    }),
    false
  );
  const service = new ProviderModelDiscoveryService({
    providerIds: () => ["antigravity"],
    adapters: {
      antigravity: {
        source: "fixture provider source",
        discover: async () => []
      }
    }
  });
  const discovery = service.snapshot().providers[0]?.discovery;
  assert.equal(discovery?.status, "unavailable");
  if (discovery?.status === "unavailable") {
    assert.match(discovery.reason, /persisted model snapshot was invalid/u);
  }
  service.stop();
  restoreProviderModelDiscoveryPersistence(previousPersistence);
  ROUTING_POLICY.setDiscoveredProviderModels("antigravity", previousDiscovered);
});
