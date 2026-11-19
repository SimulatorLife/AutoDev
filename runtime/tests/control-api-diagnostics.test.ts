import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CONTROL_API_CONTRACT } from "@simulatorlife/autodev-core";

import {
  handleControlApiDiagnosticsRequest,
  setControlApiDiagnosticsRouterStatusSource
} from "../src/control-api/diagnostics.ts";
import {
  handleControlApiRequest,
  setControlApiDiagnosticsHandler
} from "../src/control-api/request-handler.ts";
import {
  makeRequest,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

const SERVICE_TOKEN = "s".repeat(64);
const SESSION_ID = "01a0ba14-d54c-78f2-9367-3f80e9a8f75f";

/**
 * The diagnostics family joins the dispatcher's routing table through a
 * registration, exactly as the router's own server does. The test registers
 * it here so the dispatcher answers the routes it owns.
 */
function registerDiagnostics(): void {
  setControlApiDiagnosticsHandler(
    (incoming, response, pathname, codexHome, repositoryRoot) =>
      handleControlApiDiagnosticsRequest(incoming, response, pathname, {
        ...(codexHome === undefined ? {} : { codexHome }),
        ...(repositoryRoot === undefined ? {} : { repositoryRoot })
      })
  );
}

registerDiagnostics();

interface DiagnosticsFixture {
  readonly codexHome: string;
  readonly cleanup: () => void;
}

function fixture(): DiagnosticsFixture {
  const codexHome = mkdtempSync(
    path.join(tmpdir(), "autodev-control-diagnostics-")
  );
  const day = path.join(codexHome, "sessions", "2026", "09", "18");
  mkdirSync(day, { recursive: true });
  const line = (timestamp: string, type: string, payload: unknown) =>
    JSON.stringify({ timestamp, type, payload });
  writeFileSync(
    path.join(day, `rollout-2026-09-18T17-00-00-${SESSION_ID}.jsonl`),
    [
      line("2026-09-18T21:18:00.000Z", "session_meta", {
        id: SESSION_ID,
        session_id: SESSION_ID,
        thread_source: "user",
        cwd: "/tmp/repo"
      }),
      line("2026-09-18T21:18:00.100Z", "turn_context", {
        model: "autodev/orchestrator"
      }),
      line("2026-09-18T21:18:00.200Z", "event_msg", {
        type: "task_started",
        turn_id: "t1"
      }),
      line("2026-09-18T21:18:06.000Z", "event_msg", {
        type: "task_complete",
        turn_id: "t1",
        last_agent_message: "done"
      })
    ].join("\n")
  );
  return {
    codexHome,
    cleanup: () => rmSync(codexHome, { recursive: true, force: true })
  };
}

function request(url: string, method = "GET"): IncomingMessage {
  const base = makeRequest(method, url);
  Object.assign(base.headers, {
    host: "127.0.0.1",
    authorization: `Bearer ${SERVICE_TOKEN}`,
    "x-autodev-actor": "diagnostics-test"
  });
  return base;
}

async function call(
  url: string,
  codexHome: string,
  method = "GET"
): Promise<ReturnType<typeof responseRecorder>> {
  const response = responseRecorder();
  const queryIndex = url.indexOf("?");
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  await handleControlApiRequest(request(url, method), response, pathname, {
    codexHome
  });
  return response;
}

function withToken<T>(run: () => T): T {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = "diagnostics-test";
  try {
    return run();
  } finally {
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
  }
}

test("the diagnostics routes require the Control API credential", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    const response = responseRecorder();
    const unauthenticated = Object.assign(
      makeRequest("GET", "/control/diagnostics/sessions/recent"),
      {
        headers: {
          host: "127.0.0.1",
          authorization: "Bearer not-the-service-token",
          "x-autodev-actor": "diagnostics-test"
        }
      }
    );
    await withToken(() =>
      handleControlApiRequest(
        unauthenticated,
        response,
        "/control/diagnostics/sessions/recent",
        { codexHome }
      )
    );
    assert.equal(response.statusCode, 401);
  } finally {
    cleanup();
  }
});

test("the recent-sessions route publishes the contract's schema", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    const response = await withToken(() =>
      call("/control/diagnostics/sessions/recent", codexHome)
    );
    assert.equal(response.statusCode, 200);
    const body = responseBody(response);
    assert.equal(body?.schema, "autodev-session-recent-v1");
    assert.equal(body?.limit, 50);
    const sessions = body?.sessions as { id: string }[];
    assert.equal(sessions[0]?.id, SESSION_ID);
  } finally {
    cleanup();
  }
});

test("the session route publishes one session's diagnostics", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    const response = await withToken(() =>
      call(`/control/diagnostics/sessions/${SESSION_ID}?offline=1`, codexHome)
    );
    assert.equal(response.statusCode, 200);
    const body = responseBody(response);
    assert.equal(body?.schema, "autodev-session-diagnostics-v1");
    assert.equal(body?.found, true);
    assert.equal(body?.rootSessionId, SESSION_ID);
    assert.equal(body?.matchedByThreadId, false);
    assert.equal((body?.threads as unknown[]).length, 1);
  } finally {
    cleanup();
  }
});

test("the session route answers text as well as json", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    const response = await withToken(() =>
      call(
        `/control/diagnostics/sessions/${SESSION_ID}?format=text&offline=1`,
        codexHome
      )
    );
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /text\/plain/u);
    assert.match(response.body, /thread 01a0ba14-d54c-78f2-9367-3f80e9a8f75f/u);
  } finally {
    cleanup();
  }
});

test("an id that matched no rollout is a found:false report, not a 404", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    const response = await withToken(() =>
      call(
        "/control/diagnostics/sessions/01a0b6ff-0000-7000-8000-000000000009?offline=1",
        codexHome
      )
    );
    assert.equal(response.statusCode, 200);
    assert.equal(responseBody(response)?.found, false);
  } finally {
    cleanup();
  }
});

test("an invalid session identity is a 400", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    const response = await withToken(() =>
      call("/control/diagnostics/sessions/process-fallback", codexHome)
    );
    assert.equal(response.statusCode, 400);
    assert.equal(
      (responseBody(response)?.error as { code?: string } | undefined)?.code,
      "autodev_control_api_invalid_session_id"
    );
  } finally {
    cleanup();
  }
});

test("a non-GET method is a 405 that names the method it allows", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    const response = await withToken(() =>
      call("/control/diagnostics/sessions/recent", codexHome, "POST")
    );
    assert.equal(response.statusCode, 405);
    assert.equal(String(response.headers.allow).toUpperCase(), "GET");
  } finally {
    cleanup();
  }
});

test("an unknown query parameter is a 400, not a silently ignored one", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    const response = await withToken(() =>
      call("/control/diagnostics/sessions/recent?unexpected=1", codexHome)
    );
    assert.equal(response.statusCode, 400);
    assert.equal(
      (responseBody(response)?.error as { code?: string } | undefined)?.code,
      "autodev_control_api_invalid_diagnostics_query"
    );
  } finally {
    cleanup();
  }
});

test("an out-of-range parameter is a 400", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    const response = await withToken(() =>
      call("/control/diagnostics/sessions/recent?limit=9999", codexHome)
    );
    assert.equal(response.statusCode, 400);
  } finally {
    cleanup();
  }
});

test("the events and items pages are bounded and paginated", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    const response = await withToken(() =>
      call(
        `/control/diagnostics/sessions/${SESSION_ID}?offline=1&includeEvents=1&eventsLimit=1`,
        codexHome
      )
    );
    assert.equal(response.statusCode, 200);
    const page = responseBody(response)?.eventsPage as {
      items: unknown[];
      limit: number;
      offset: number;
      hasMore: boolean;
    };
    assert.equal(page.limit, 1);
    assert.equal(page.offset, 0);
    assert.equal(page.items.length <= 1, true);
  } finally {
    cleanup();
  }
});

test("the hook denials and the fleet scan answer their own routes", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    const hooks = await withToken(() =>
      call("/control/diagnostics/hooks?sinceDays=7", codexHome)
    );
    assert.equal(hooks.statusCode, 200);
    assert.equal(
      responseBody(hooks)?.schema,
      "autodev-session-hook-denials-v1"
    );

    const scan = await withToken(() =>
      call("/control/diagnostics/sessions/scan?limit=5", codexHome)
    );
    assert.equal(scan.statusCode, 200);
    assert.equal(responseBody(scan)?.schema, "autodev-session-fleet-scan-v1");
  } finally {
    cleanup();
  }
});

test("the live router status is read in-process, not over loopback", async () => {
  const { codexHome, cleanup } = fixture();
  try {
    setControlApiDiagnosticsRouterStatusSource(() => ({
      agents: { canonicalLiveCount: 3, byState: { running: 3 } },
      providers: {}
    }));
    const response = await withToken(() =>
      call(`/control/diagnostics/sessions/${SESSION_ID}`, codexHome)
    );
    assert.equal(response.statusCode, 200);
    const live = responseBody(response)?.live as {
      router: { reachable: boolean; canonicalLiveCount: number | null };
    } | null;
    assert.equal(live?.router.reachable, true);
    assert.equal(live?.router.canonicalLiveCount, 3);
  } finally {
    setControlApiDiagnosticsRouterStatusSource(null);
    cleanup();
  }
});

test("the diagnostics routes arrived with contract v35", () => {
  assert.equal(CONTROL_API_CONTRACT.version, 35);
  assert.equal(CONTROL_API_CONTRACT.path, "/control/contracts");
});
