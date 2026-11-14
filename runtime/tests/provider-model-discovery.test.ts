import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  copilotModelSource,
  createAntigravityModelDiscoveryAdapters,
  discoverBridgeModels,
  discoverCodexModels,
  discoverMiniMaxModels,
  opencliModelSource,
  parseAntigravityModelList,
  parseCodexModelList,
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

function fakeAgy(body: string): {
  readonly env: NodeJS.ProcessEnv;
  readonly dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "autodev-agy-"));
  const executable = join(dir, "agy");
  writeFileSync(executable, "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
  return {
    dir,
    env: { AGY_CLI_PATH: executable, PATH: process.env.PATH ?? "" }
  };
}

async function geminiListing(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal = new AbortController().signal,
  timeoutMs?: number
): Promise<unknown> {
  const adapter = createAntigravityModelDiscoveryAdapters(env, timeoutMs)[
    "antigravity-gemini"
  ];
  return adapter.discover(signal).then(
    (models) => models,
    (error: unknown) => error
  );
}

test("Antigravity discovery runs agy once, shares the listing across providers, and filters per provider", async (t) => {
  const { env, dir } = fakeAgy(
    'echo run >> "$0.runs"\nsleep 0.2\nprintf "%s\\n" "gemini-3.8-flash-low	Gemini 3.8 Flash (Low)" "gpt-oss-120b-medium	GPT OSS 120B (Medium)"'
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adapters = createAntigravityModelDiscoveryAdapters(env);
  const signal = new AbortController().signal;
  const [gemini, argon, claudeGpt] = await Promise.all([
    adapters["antigravity-gemini"].discover(signal),
    adapters["antigravity-argon"].discover(signal),
    adapters["antigravity-claude-gpt"].discover(signal)
  ]);
  assert.equal(readFileSync(env.AGY_CLI_PATH + ".runs", "utf8"), "run\n");
  assert.deepEqual(gemini, [
    { id: "gemini-3.8-flash-low", displayName: "Gemini 3.8 Flash (Low)" }
  ]);
  assert.deepEqual(argon, []);
  assert.deepEqual(claudeGpt, [
    { id: "gpt-oss-120b-medium", displayName: "GPT OSS 120B (Medium)" }
  ]);
});

test("Antigravity discovery runs agy with the given env only, not the Runtime's", async (t) => {
  const { env, dir } = fakeAgy(
    String.raw`printf "%s\n" "gemini-3.8-flash-low	@@{AUTODEV_AGY_PROBE:-absent}"`.replace(
      "@@",
      "$"
    )
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previousProbe = process.env.AUTODEV_AGY_PROBE;
  process.env.AUTODEV_AGY_PROBE = "leaked";
  t.after(() => {
    if (previousProbe === undefined) delete process.env.AUTODEV_AGY_PROBE;
    else process.env.AUTODEV_AGY_PROBE = previousProbe;
  });
  assert.deepEqual(await geminiListing(env), [
    { id: "gemini-3.8-flash-low", displayName: "absent" }
  ]);
});

test("Antigravity discovery remains bounded when the CLI stalls", async (t) => {
  const { env, dir } = fakeAgy("exec sleep 30");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const error = await geminiListing(env, new AbortController().signal, 200);
  assert.ok(error instanceof Error);
  assert.match(error.message, /agy model discovery timed out/u);
});

test("Antigravity discovery cancels and terminates a running listing", async (t) => {
  const { env, dir } = fakeAgy("exec sleep 30");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const outcome = geminiListing(env, controller.signal);
  setTimeout(() => controller.abort(), 100).unref();
  const error = await outcome;
  assert.ok(error instanceof Error);
  assert.match(error.message, /provider model discovery was cancelled/u);
});

test("Antigravity discovery does not start agy for an already-cancelled listing", async (t) => {
  const { env, dir } = fakeAgy('echo run >> "$0.runs"');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const error = await geminiListing(env, AbortSignal.abort());
  assert.ok(error instanceof Error);
  assert.match(error.message, /provider model discovery was cancelled/u);
  assert.throws(() => readFileSync(env.AGY_CLI_PATH + ".runs"), /ENOENT/u);
});

test("Antigravity discovery rejects output over the 64 KiB bound", async (t) => {
  const { env, dir } = fakeAgy(String.raw`head -c 70000 /dev/zero | tr '\0' a`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const error = await geminiListing(env);
  assert.ok(error instanceof Error);
  assert.match(error.message, /agy model list exceeded the response bound/u);
});

test("Antigravity discovery reports a failing exit status", async (t) => {
  const { env, dir } = fakeAgy("exit 3");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const error = await geminiListing(env);
  assert.ok(error instanceof Error);
  assert.match(error.message, /agy models exited with status 3/u);
});

test("Antigravity discovery reports an agy that cannot be started", async () => {
  const error = await geminiListing({
    AGY_CLI_PATH: "/nonexistent/autodev/agy",
    PATH: process.env.PATH ?? ""
  });
  assert.ok(error instanceof Error);
  assert.match(error.message, /agy models could not be started/u);
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

test("Copilot model discovery asks the bridge for the models the Runtime can route", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const models = await discoverBridgeModels(
    copilotModelSource({} as NodeJS.ProcessEnv),
    async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return Response.json({
        object: "list",
        data: [{ id: "copilot", object: "model", owned_by: "github" }]
      });
    }
  );
  assert.deepEqual(models, [{ id: "copilot", displayName: null }]);
  assert.deepEqual(requests, [
    { url: "http://127.0.0.1:4003/v1/models", method: "GET" }
  ]);
});

test("Copilot model discovery honours the bridge's configured address", async () => {
  const requests: string[] = [];
  await discoverBridgeModels(
    copilotModelSource({
      COPILOT_PROXY_HOST: "127.0.0.2",
      COPILOT_PROXY_PORT: "4999"
    } as NodeJS.ProcessEnv),
    async (input) => {
      requests.push(String(input));
      return Response.json({ object: "list", data: [] });
    }
  );
  assert.deepEqual(requests, ["http://127.0.0.2:4999/v1/models"]);
});

test("Copilot model discovery refuses a failed or malformed listing", async () => {
  await assert.rejects(
    discoverBridgeModels(
      copilotModelSource({} as NodeJS.ProcessEnv),
      async () => Response.json({ error: "nope" }, { status: 500 })
    ),
    /returned HTTP 500/u
  );
  await assert.rejects(
    discoverBridgeModels(
      copilotModelSource({} as NodeJS.ProcessEnv),
      async () =>
        Response.json({ object: "list", data: [{ id: "invalid/id" }] })
    ),
    /invalid or duplicate model ID/u
  );
  await assert.rejects(
    discoverBridgeModels(
      copilotModelSource({} as NodeJS.ProcessEnv),
      async () =>
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    ),
    /invalid JSON/u
  );
});

test("each opencli provider discovers its own site's models from the shared bridge", async () => {
  const requests: string[] = [];
  const listing = async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json({
      object: "list",
      data: [
        { id: "opencli-chatgpt-advanced", object: "model" },
        { id: "opencli-gemini-3.1-pro", object: "model" },
        { id: "opencli-gemini-3.8-flash", object: "model" }
      ]
    });
  };
  assert.deepEqual(
    await discoverBridgeModels(
      opencliModelSource("opencli-gemini", {} as NodeJS.ProcessEnv),
      listing
    ),
    [
      { id: "opencli-gemini-3.1-pro", displayName: null },
      { id: "opencli-gemini-3.8-flash", displayName: null }
    ]
  );
  assert.deepEqual(
    await discoverBridgeModels(
      opencliModelSource("opencli-chatgpt", {} as NodeJS.ProcessEnv),
      listing
    ),
    [{ id: "opencli-chatgpt-advanced", displayName: null }]
  );
  // Each provider asks for its own list, so one slow site does not hold
  // the other's listing.
  assert.deepEqual(requests, [
    "http://127.0.0.1:4004/v1/models?provider=opencli-gemini",
    "http://127.0.0.1:4004/v1/models?provider=opencli-chatgpt"
  ]);
  await assert.rejects(
    discoverBridgeModels(
      opencliModelSource("opencli-gemini", {} as NodeJS.ProcessEnv),
      async () => Response.json({ error: "nope" }, { status: 503 })
    ),
    /opencli-gemini bridge model list returned HTTP 503/u
  );
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

test("Codex discovery queries the authenticated account model endpoint", async () => {
  const requests: Array<{
    url: string;
    authorization: string | null;
    accountId: string | null;
  }> = [];
  const models = await discoverCodexModels(
    async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        accountId: headers.get("chatgpt-account-id")
      });
      return Response.json({
        models: [
          {
            slug: "gpt-6-luna",
            display_name: "GPT-6 Luna",
            visibility: "list",
            supported_in_api: true
          },
          {
            slug: "codex-new-account-model",
            display_name: "New Model",
            visibility: "list",
            supported_in_api: true
          }
        ]
      });
    },
    async () => ({
      token: "fixture-account-token",
      accountId: "fixture-account"
    })
  );

  assert.deepEqual(models, [
    { id: "gpt-6-luna", displayName: "GPT-6 Luna" },
    { id: "codex-new-account-model", displayName: "New Model" }
  ]);
  assert.deepEqual(requests, [
    {
      url: "https://chatgpt.com/backend-api/codex/models?client_version=0.999.0",
      authorization: "Bearer fixture-account-token",
      accountId: "fixture-account"
    }
  ]);
  assert.deepEqual(
    parseCodexModelList({ models: [] }),
    [],
    "an empty successful account listing is an observation"
  );
});

/**
 * The account model list is filtered by the client version the caller
 * declares. The Runtime drives the Codex backend directly, so the installed
 * CLI's release is not a bound on what the Runtime can use: declaring it
 * hid the models the Runtime's own routing configuration selects, while the
 * Runtime drove them successfully all the same.
 */
test("Codex discovery does not narrow the account list by the installed CLI version", async () => {
  const requested: string[] = [];
  await discoverCodexModels(
    async (input) => {
      requested.push(
        new URL(String(input)).searchParams.get("client_version") ?? ""
      );
      return Response.json({ models: [] });
    },
    async () => ({
      token: "fixture-account-token",
      accountId: "fixture-account"
    })
  );
  assert.deepEqual(requested, ["0.999.0"]);
});

/**
 * The account keeps platform-internal models out of a model picker and marks
 * the ones it does not serve through the API. Offering them as role
 * assignments would offer a choice the provider itself does not offer.
 */
test("Codex discovery offers only the models the account lists for a picker", () => {
  assert.deepEqual(
    parseCodexModelList({
      models: [
        { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list" },
        { slug: "gpt-reserve", visibility: "hide" },
        {
          slug: "codex-auto-review",
          visibility: "hide",
          supported_in_api: true
        },
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6 Sol",
          visibility: "list",
          supported_in_api: false
        }
      ]
    }),
    [{ id: "gpt-6-luna", displayName: "GPT-6 Luna" }]
  );
});

test("Codex discovery rejects malformed account listings without leaking auth", async () => {
  await assert.rejects(
    discoverCodexModels(
      async () => Response.json({ models: [{ slug: "invalid/model" }] }),
      async () => ({ token: "fixture-secret", accountId: "fixture-account" })
    ),
    /invalid or duplicate model ID/u
  );
  await assert.rejects(
    discoverCodexModels(
      async () => {
        throw new Error("network error");
      },
      async () => {
        throw new Error(
          "invalid auth at /private/path with secret fixture-secret"
        );
      }
    ),
    (error: Error) => {
      assert.equal(
        error.message,
        "Codex account authentication is unavailable for model discovery."
      );
      assert.doesNotMatch(error.message, /fixture-secret|private\/path/u);
      return true;
    }
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
    providerIds: () => ["antigravity-gemini", "claude", "minimax", "copilot"],
    adapters: {
      "antigravity-gemini": observedAdapter,
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
    (entry) => entry.provider === "antigravity-gemini"
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
    providerIds: () => ["antigravity-gemini"],
    adapters: { "antigravity-gemini": adapter },
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

test("an empty listing keeps the provider's last non-empty models", async () => {
  restoreProviderModelDiscoveryPersistence(null);
  let empty = false;
  const service = new ProviderModelDiscoveryService({
    providerIds: () => ["antigravity-gemini"],
    adapters: {
      "antigravity-gemini": {
        source: "fixture provider list",
        discover: async () =>
          empty ? [] : parseAntigravityModelList(AGY_MODELS)
      }
    },
    retryBaseMs: 60_000
  });
  await service.refresh();
  empty = true;
  await service.refresh();
  const discovery = service.snapshot().providers[0]?.discovery;
  assert.equal(discovery?.status, "stale");
  if (discovery?.status !== "stale") assert.fail("the last listing is kept");
  assert.equal(discovery.models.length, 2);
  assert.match(discovery.reason, /listed no models/u);
  service.stop();
  restoreProviderModelDiscoveryPersistence(null);
});

test("a failed listing is retried soon rather than at the next refresh interval", async () => {
  restoreProviderModelDiscoveryPersistence(null);
  let attempts = 0;
  const service = new ProviderModelDiscoveryService({
    providerIds: () => ["antigravity-gemini"],
    adapters: {
      "antigravity-gemini": {
        source: "fixture provider list",
        discover: async () => {
          attempts += 1;
          // The bridge was not up yet on the first attempt.
          if (attempts === 1) throw new Error("fetch failed");
          return parseAntigravityModelList(AGY_MODELS);
        }
      }
    },
    refreshIntervalMs: 60 * 60_000,
    retryBaseMs: 10
  });
  service.start();
  const deadline = Date.now() + 2000;
  while (
    service.snapshot().providers[0]?.discovery.status !== "observed" &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(service.snapshot().providers[0]?.discovery.status, "observed");
  assert.equal(attempts, 2);
  service.stop();
  restoreProviderModelDiscoveryPersistence(null);
});

test("last-known provider models survive restart as stale until a fresh listing succeeds", async () => {
  const provider = "antigravity-gemini";
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
    .filter((model) => model.provider === "antigravity-gemini")
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
          provider: "antigravity-gemini",
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
    providerIds: () => ["antigravity-gemini"],
    adapters: {
      "antigravity-gemini": {
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
  ROUTING_POLICY.setDiscoveredProviderModels(
    "antigravity-gemini",
    previousDiscovered
  );
});

test("providers without verified provider-owned listings remain unavailable", async () => {
  const service = new ProviderModelDiscoveryService({
    providerIds: () => ["codex", "claude", "copilot"],
    adapters: {}
  });

  await service.refresh();

  for (const entry of service.snapshot().providers) {
    assert.deepEqual(entry.discovery, {
      status: "unavailable",
      source: null,
      lastAttemptAt: null,
      reason:
        "No machine-readable model discovery adapter is configured for this provider."
    });
  }
  service.stop();
});

test("a bridge listing refused for a signed-out account is reported as a sign-in", async () => {
  const signIns: Array<[string, string | null]> = [];
  let signedIn = false;
  const service = new ProviderModelDiscoveryService({
    providerIds: () => ["opencli-gemini"],
    adapters: {
      "opencli-gemini": {
        source: "opencli-gemini bridge GET /v1/models",
        discover: () =>
          discoverBridgeModels(
            opencliModelSource("opencli-gemini", {} as NodeJS.ProcessEnv),
            async () =>
              signedIn
                ? Response.json({
                    object: "list",
                    data: [{ id: "opencli-gemini-3.1-pro", object: "model" }]
                  })
                : Response.json(
                    {
                      error: {
                        type: "authentication_error",
                        code: "sign_in_required",
                        message: "Not logged in to gemini.google.com"
                      }
                    },
                    { status: 401 }
                  )
          )
      }
    },
    onSignIn: (provider, detail) => signIns.push([provider, detail])
  });
  try {
    const refused = await service.refreshProvider("opencli-gemini");
    assert.equal(refused?.status, "unavailable");
    assert.match(
      refused?.status === "unavailable" ? refused.reason : "",
      /Not logged in/u
    );
    signedIn = true;
    await service.refreshProvider("opencli-gemini");
    assert.deepEqual(signIns, [
      ["opencli-gemini", "Not logged in to gemini.google.com"],
      ["opencli-gemini", null]
    ]);
  } finally {
    service.stop();
  }
});
