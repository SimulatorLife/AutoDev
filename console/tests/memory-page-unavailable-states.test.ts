import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import MemoryPage from "../app/memory/page.ts";

/**
 * The states the memory page can be in that nothing was reaching.
 *
 * `app/memory/page.ts` renders four kinds of "you cannot see memory right now",
 * and not one of them was rendered by a test:
 *
 *   - no Control API credential at all (`renderNoControlApiShell`);
 *   - a workspace catalog that is unreadable, invalid, or simply empty — three
 *     different problems that each fail *closed*, before any memory read;
 *   - the storage callout, in both of its states, including the one its own
 *     comment calls "the one no read failure ever names": memory connected with
 *     no embedding provider, where records capture fine and then cannot be
 *     retrieved, which looks exactly like memory that does not work;
 *   - a detail read that failed while its list succeeded, for the record, its
 *     history, and the selected experience.
 *
 * These are the branches an operator meets when something is already wrong, so
 * they are the branches that must not rot. A page that rendered an empty list
 * instead of a refusal would be indistinguishable from "no memories yet".
 */

const ENV_KEYS = [
  "HOME",
  "CODEX_HOME",
  "AUTODEV_OPENLIT_SECRET_FILE",
  "AUTODEV_CONTROL_API_TOKEN",
  "AUTODEV_CONTROL_API_BASE_URL"
] as const;

function saveEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface RouteOptions {
  readonly token?: string;
  readonly workspaces?: Record<string, unknown>;
  readonly status?: Record<string, unknown> | null;
  readonly fail?: (path: string) => boolean;
}

function recordsResponse(): Record<string, unknown> {
  return {
    schema: "autodev-memory-records-v1",
    items: [],
    total: 0,
    limit: 50,
    statusCounts: {
      proposed: 0,
      active: 0,
      superseded: 0,
      invalidated: 0,
      uncertain: 0
    },
    offset: 0,
    hasMore: false
  };
}

function statusResponse(
  storage: Record<string, unknown>
): Record<string, unknown> {
  return {
    schema: "autodev-memory-status-v1",
    storage: { backend: "postgresql", probeTimeoutMs: 2500, ...storage }
  };
}

const HEALTHY_STORAGE = { state: "reachable", embeddings: "configured" };

function experiencesResponse(): Record<string, unknown> {
  return {
    schema: "autodev-memory-experiences-v1",
    items: [],
    total: 0,
    limit: 50,
    offset: 0,
    hasMore: false
  };
}

/** A minimal row that passes `isMemoryRecordRow`, so the detail read succeeds. */
function recordResponse(): Record<string, unknown> {
  return {
    schema: "autodev-memory-record-v1",
    memory: {
      id: "mem-1",
      kind: "semantic",
      scope: {
        kind: "repository",
        workspaceId: "SimulatorLife/AutoDev",
        repositoryId: "SimulatorLife/AutoDev"
      },
      claim: "The memory repository resolves packets through MemoryService.",
      status: "active",
      provenance: { experienceIds: ["exp-1"], evidence: [] },
      validity: { state: "verified" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  };
}

/**
 * Routes by path. The detail, `why` and `history` reads all sit under
 * `/control/memory/records/`, so they are matched before the list, which is the
 * same order the Runtime nests them in.
 *
 * Everything a test is *not* exercising answers successfully. A failing list
 * read would short-circuit the detail checks further down, so the test for "the
 * history read failed" has to prove that failure against an otherwise complete
 * page -- otherwise it asserts the wrong branch and passes for the wrong reason.
 */
function route(path: string, options: RouteOptions): Response | null {
  if (options.fail?.(path) === true) {
    return Response.json({ error: "forced failure" }, { status: 500 });
  }
  if (path.startsWith("/control/workspaces")) {
    return Response.json(
      options.workspaces ?? {
        schema: "autodev-control-workspaces-v1",
        source: "config/workspaces.json",
        readOnly: true,
        catalogStatus: "valid",
        totalWorkspaces: 1,
        workspaces: [
          {
            id: "SimulatorLife/AutoDev",
            baseBranch: "main",
            enabled: true,
            agentRoles: null
          }
        ]
      }
    );
  }
  if (path.startsWith("/control/memory/status")) {
    if (options.status === null) {
      return Response.json({ error: "forced failure" }, { status: 500 });
    }
    return Response.json(options.status ?? statusResponse(HEALTHY_STORAGE));
  }
  if (/^\/control\/memory\/records\/[^/?]+\/(why|history)\b/u.test(path)) {
    return Response.json(
      path.includes("/history")
        ? {
            schema: "autodev-memory-history-v1",
            memory: recordResponse().memory,
            transitions: [],
            relatedMemories: []
          }
        : {
            schema: "autodev-memory-why-v1",
            memory: recordResponse().memory,
            reasons: []
          },
      { status: 200 }
    );
  }
  if (/^\/control\/memory\/records\/[^/?]+\?/u.test(path)) {
    return Response.json(recordResponse());
  }
  if (/^\/control\/memory\/experiences\/[^/?]+\?/u.test(path)) {
    return Response.json({ error: "no such experience" }, { status: 404 });
  }
  if (path.startsWith("/control/memory/experiences")) {
    return Response.json(experiencesResponse());
  }
  if (path.startsWith("/control/memory/records")) {
    return Response.json(recordsResponse());
  }
  return null;
}

async function renderMemoryPage(
  searchParams: Record<string, string>,
  options: RouteOptions = {}
): Promise<{ readonly markup: string; readonly paths: readonly string[] }> {
  const previousFetch = globalThis.fetch;
  const saved = saveEnv();
  const isolatedHome = mkdtempSync(join(tmpdir(), "autodev-memory-states-"));
  const paths: string[] = [];
  try {
    process.env.HOME = isolatedHome;
    process.env.CODEX_HOME = isolatedHome;
    process.env.AUTODEV_OPENLIT_SECRET_FILE = join(isolatedHome, "missing.env");
    process.env.AUTODEV_CONTROL_API_TOKEN =
      options.token ?? "memory-states-token";
    process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/u, "");
      paths.push(path);
      const response = route(path, options);
      if (!response) throw new Error(`Unexpected Memory page request: ${path}`);
      return response;
    }) as typeof fetch;
    const markup = renderToStaticMarkup(
      await MemoryPage({ searchParams: Promise.resolve(searchParams) })
    );
    return { markup, paths };
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(saved);
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

test("no Control API credential is named, not left to fail silently", async () => {
  const { markup, paths } = await renderMemoryPage({}, { token: "" });

  assert.match(markup, /data-error-code="autodev_control_api_disabled"/u);
  assert.match(markup, /Set AUTODEV_CONTROL_API_TOKEN/u);
  assert.deepEqual(
    paths,
    [],
    "an unconfigured credential must be reported before any read is attempted"
  );
});

test("a workspace catalog that is unreadable fails closed before any memory read", async () => {
  const { markup, paths } = await renderMemoryPage(
    {},
    {
      workspaces: {
        schema: "autodev-control-workspaces-v1",
        source: "config/workspaces.json",
        readOnly: true,
        catalogStatus: "unavailable",
        totalWorkspaces: 0,
        workspaces: []
      }
    }
  );

  assert.match(
    markup,
    /data-error-code="autodev_workspace_catalog_unavailable"/u
  );
  assert.match(markup, /no Memory scope is inferred/u);
  assert.equal(
    paths.some((path) => path.startsWith("/control/memory/")),
    false,
    "an unreadable catalog must not be papered over with a guessed scope"
  );
});

test("an empty workspace catalog names the missing configuration, not an empty list", async () => {
  const { markup, paths } = await renderMemoryPage(
    {},
    {
      workspaces: {
        schema: "autodev-control-workspaces-v1",
        source: "config/workspaces.json",
        readOnly: true,
        catalogStatus: "valid",
        totalWorkspaces: 0,
        workspaces: []
      }
    }
  );

  assert.match(markup, /data-error-code="autodev_workspace_catalog_empty"/u);
  assert.match(markup, /no default workspace is substituted/u);
  assert.equal(
    paths.some((path) => path.startsWith("/control/memory/")),
    false
  );
});

test("a configured but unreachable store is announced on an otherwise healthy page", async () => {
  const { markup } = await renderMemoryPage(
    {},
    {
      status: statusResponse({
        ...HEALTHY_STORAGE,
        state: "unreachable",
        probeTimeoutMs: 2500
      })
    }
  );

  // The records read succeeds here, which is the trap: reads that work are not
  // evidence that memory works, and the page has to say so rather than let a
  // green list imply a healthy store.
  assert.match(markup, /did not answer within 2500ms/u);
  assert.match(markup, /not evidence that memory is working/u);
});

test("memory connected with no embedding provider is announced, because no read failure names it", async () => {
  const { markup } = await renderMemoryPage(
    {},
    {
      status: statusResponse({
        ...HEALTHY_STORAGE,
        embeddings: "not_configured"
      })
    }
  );

  assert.match(markup, /no embedding provider configured/u);
  assert.match(
    markup,
    /Configure an embedding provider to make retrieval work\./u
  );
});

test("a healthy store and an unobserved status both render no storage banner", async () => {
  // A banner on every healthy load is chrome: it trains the operator to read
  // past the one place it matters. And a status read that failed is not evidence
  // of anything, so it must not be turned into a guess about the store.
  const healthy = await renderMemoryPage(
    {},
    { status: statusResponse(HEALTHY_STORAGE) }
  );
  const unobserved = await renderMemoryPage({}, { status: null });

  for (const { markup } of [healthy, unobserved]) {
    assert.doesNotMatch(markup, /did not answer within/u);
    assert.doesNotMatch(markup, /no embedding provider configured/u);
  }
});

test("a failed detail read is reported even though the list beside it succeeded", async () => {
  const { markup } = await renderMemoryPage(
    { tab: "records", recordId: "mem-missing" },
    {
      status: statusResponse(HEALTHY_STORAGE),
      fail: (path) => /^\/control\/memory\/records\/mem-missing\?/u.test(path)
    }
  );

  assert.match(markup, /Selected memory record could not be loaded/u);
});

test("a failed history read is reported as its own problem, not as a missing record", async () => {
  const { markup } = await renderMemoryPage(
    { tab: "records", recordId: "mem-h" },
    {
      status: statusResponse(HEALTHY_STORAGE),
      fail: (path) => path.includes("/mem-h/history")
    }
  );

  assert.match(markup, /Memory record history could not be loaded/u);
});

test("a failed experience detail read is reported on the experiences tab", async () => {
  const { markup } = await renderMemoryPage(
    { tab: "experiences", experienceId: "exp-missing" },
    {
      status: statusResponse(HEALTHY_STORAGE),
      fail: (path) =>
        /^\/control\/memory\/experiences\/exp-missing\?/u.test(path)
    }
  );

  assert.match(markup, /Selected memory experience could not be loaded/u);
});

test("a failed experience list is reported as a failed read, not as no experiences", async () => {
  // The list read is unconditional, so this guard is keyed off the active tab
  // rather than off the `requested` tag the detail reads carry. Rendering an
  // empty list here would claim "this scope has no experiences" on the strength
  // of a read that never completed.
  const { markup } = await renderMemoryPage(
    { tab: "experiences" },
    {
      status: statusResponse(HEALTHY_STORAGE),
      fail: (path) => /^\/control\/memory\/experiences\?/u.test(path)
    }
  );

  assert.match(markup, /Memory experiences could not be loaded/u);
});

test("an unreachable workspace source is reported as unreadable, not as empty", async () => {
  // The catalog answering "unavailable" and the catalog read *failing* are both
  // "no scope could be established", and neither may quietly resolve to the
  // first workspace or to an empty list. Failing closed is the whole point of
  // resolving scope exclusively against the canonical source.
  const { markup, paths } = await renderMemoryPage(
    {},
    {
      fail: (path) => path.startsWith("/control/workspaces")
    }
  );

  assert.match(markup, /Workspace configuration could not be loaded/u);
  assert.equal(
    paths.some((path) => path.startsWith("/control/memory/")),
    false,
    "an unreadable workspace source must not be replaced with a guessed scope"
  );
});

test("a failed records read is diagnosed from the status read, one state at a time", async () => {
  // The records read answers 503 for "nobody configured a database" and for "the
  // database is not answering", and those send an operator to two different
  // places. The reason is read from the status read rather than inferred from the
  // failure -- and when the status read itself did not answer, the page says so
  // instead of falling back to the guess it replaced. A guess that is right most
  // of the time is what makes a wrong one expensive.
  // Each case asserts the title the diagnosis is *delivered as*. Two of the four
  // states name the storage problem as the headline itself rather than as a
  // subordinate hint, so there is no one title to assert in common -- only the
  // refusal shell itself.
  const cases = [
    {
      storage: { state: "not_configured", embeddings: "configured" },
      expect: /Memory storage is not configured/u,
      reason: "nothing configured storage"
    },
    {
      storage: { state: "unreachable", embeddings: "configured" },
      expect: /Memory storage is unreachable/u,
      reason: "storage configured but not answering"
    },
    {
      storage: HEALTHY_STORAGE,
      expect:
        /Durable memory storage answered, so this read failed on its own terms rather than because the store is down\./u,
      reason: "storage answered, so the read failed on its own terms"
    }
  ] as const;

  for (const testCase of cases) {
    const { markup } = await renderMemoryPage(
      {},
      {
        status: statusResponse(testCase.storage),
        fail: (path) => path.startsWith("/control/memory/records")
      }
    );
    assert.match(
      markup,
      /data-error-code=/u,
      `a failed read must render a refusal, not a list (${testCase.reason})`
    );
    assert.match(
      markup,
      testCase.expect,
      `the diagnosis must name ${testCase.reason}`
    );
  }
});

test("an unobserved status leaves the failed read undiagnosed rather than guessed", async () => {
  const { markup } = await renderMemoryPage(
    {},
    {
      status: null,
      fail: (path) => path.startsWith("/control/memory/records")
    }
  );

  assert.match(
    markup,
    /Storage status was not observed, so whether memory is configured could not be confirmed\./u
  );
  assert.doesNotMatch(
    markup,
    /is not configured|is unreachable/u,
    "with no status read, the page must not name a cause it did not observe"
  );
});
