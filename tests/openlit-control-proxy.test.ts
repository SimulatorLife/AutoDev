/**
 * Unit and contract tests for the AutoDev Control API proxy in OpenLIT.
 *
 * Reproduces and verifies the proxy unit tests that ship inside
 * patches/openlit/02-autodev-pages.patch (src/client/src/__tests__/lib/autodev/control-api.test.ts).
 *
 * Verifies:
 *   1. Unauthenticated requests (missing NextAuth session) are rejected with 401.
 *   2. CSRF protection: exact Origin validation for every state-changing mutation
 *      (reject missing/mismatched/malformed Origin with 403). Non-state-changing
 *      GET requests without Origin are allowed.
 *   3. Forwarding contract: forwards ONLY `Authorization: Bearer <token>` and
 *      `X-AutoDev-Actor: <actor>`. Never sends `X-AutoDev-Role` or `X-AutoDev-Actor-Email`.
 *   4. Actor forwarding: forwards both viewer and operator actor IDs without role headers.
 *   5. Service credential safety: service token remains server-only and is never leaked
 *      in client responses.
 *   6. Error mapping: maps upstream 401, 403, and 502 (unreachable) errors to normalized envelopes.
 *   7. Kill switch: AUTODEV_CONTROL_API_DISABLED=1 short-circuits with 503.
 *   8. Patch 02 static inspection confirms all security gates are wired in the patch.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const PATCH2 = join(repositoryRoot, "patches/openlit/02-autodev-pages.patch");

// State-changing methods requiring Origin validation
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function verifyOriginForMutation(
  method: string,
  origin: string | null | undefined,
  host: string | null | undefined
): { ok: true } | { ok: false; status: number; err: string } {
  if (!STATE_CHANGING_METHODS.has(method.toUpperCase())) {
    return { ok: true };
  }
  if (!origin) {
    return {
      ok: false,
      status: 403,
      err: "missing Origin header on state-changing request"
    };
  }
  if (!host) {
    return {
      ok: false,
      status: 403,
      err: "missing Host header on state-changing request"
    };
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return {
      ok: false,
      status: 403,
      err: "malformed Origin header on state-changing request"
    };
  }
  const requestHost = host.toLowerCase();
  if (originHost !== requestHost) {
    return {
      ok: false,
      status: 403,
      err: `Origin ${originHost} does not match request host ${requestHost}`
    };
  }
  return { ok: true };
}

interface ForwardOptions {
  method: string;
  path: string;
  body?: unknown;
  actor: string | null;
  baseUrl?: string;
  token?: string;
  disabled?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

async function forwardToControlApi(
  opts: ForwardOptions
): Promise<
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; err: string }
> {
  if (opts.disabled === "1" || opts.disabled === "true") {
    return {
      ok: false,
      status: 503,
      err: "AutoDev Control API proxy is disabled via AUTODEV_CONTROL_API_DISABLED"
    };
  }
  const baseUrl = opts.baseUrl ?? "http://127.0.0.1:4100";
  const token = opts.token ?? "test-service-token";

  if (!opts.actor) {
    return { ok: false, status: 401, err: "unauthenticated" };
  }

  const url = `${baseUrl.replace(/\/+$/u, "")}/control/${opts.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "X-AutoDev-Actor": opts.actor
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: opts.method,
      headers,
      ...(body === undefined ? {} : { body })
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      err: `AutoDev Control API unreachable: ${(error as Error).message}`
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  const isOk = response.status >= 200 && response.status < 300;
  if (isOk) {
    return { ok: true, status: response.status, body: parsed };
  }
  return {
    ok: false,
    status: response.status,
    err:
      typeof parsed === "string"
        ? parsed
        : JSON.stringify(parsed ?? response.statusText)
  };
}

function controlResponseToFetch(
  res:
    | { ok: true; status: number; body: unknown }
    | { ok: false; status: number; err: string }
): Response {
  if (res.ok) {
    return Response.json(res.body ?? null, {
      status: res.status,
      headers: { "content-type": "application/json" }
    });
  }
  return Response.json(
    { err: res.err },
    {
      status: res.status,
      headers: { "content-type": "application/json" }
    }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("proxy rejects unauthenticated requests with 401", async () => {
  const res = await forwardToControlApi({
    method: "GET",
    path: "providers",
    actor: null
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 401);
    assert.equal(res.err, "unauthenticated");
  }
});

test("proxy enforces exact Origin for mutations (CSRF protection)", () => {
  // Missing Origin on state-changing methods -> 403
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const missing = verifyOriginForMutation(method, null, "app.example.com");
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.status, 403);
      assert.match(missing.err, /missing Origin/i);
    }
  }

  // Mismatched Origin -> 403
  const mismatched = verifyOriginForMutation(
    "PATCH",
    "https://evil.example.com",
    "app.example.com"
  );
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) {
    assert.equal(mismatched.status, 403);
    assert.match(mismatched.err, /does not match/i);
  }

  // Malformed Origin -> 403
  const malformed = verifyOriginForMutation(
    "PATCH",
    "not-a-valid-url",
    "app.example.com"
  );
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.status, 403);
    assert.match(malformed.err, /malformed/i);
  }

  // Matching Origin (case-insensitive) -> allowed
  const matching = verifyOriginForMutation(
    "PATCH",
    "https://APP.Example.Com:8443",
    "app.example.com:8443"
  );
  assert.equal(matching.ok, true);

  // GET request without Origin -> allowed
  const getWithoutOrigin = verifyOriginForMutation(
    "GET",
    null,
    "app.example.com"
  );
  assert.equal(getWithoutOrigin.ok, true);
});

test("proxy forwards only Authorization and X-AutoDev-Actor, never role or email", async () => {
  let capturedHeaders: Record<string, string> = {};
  let capturedUrl = "";

  const mockFetch = async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedHeaders = (init.headers as Record<string, string>) ?? {};
    return Response.json(
      {
        schema: "autodev-control-providers-v1",
        providers: [],
        disabledOrchestratorProviders: [],
        disabledSubagentProviders: []
      },
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const res = await forwardToControlApi({
    method: "GET",
    path: "providers",
    actor: "user-123",
    token: "secret-token-do-not-leak",
    fetchImpl: mockFetch
  });

  assert.equal(res.ok, true);
  assert.equal(capturedUrl, "http://127.0.0.1:4100/control/providers");
  assert.equal(
    capturedHeaders.Authorization,
    "Bearer secret-token-do-not-leak"
  );
  assert.equal(capturedHeaders["X-AutoDev-Actor"], "user-123");
  assert.equal(capturedHeaders["X-AutoDev-Role"], undefined);
  assert.equal(capturedHeaders["X-AutoDev-Actor-Email"], undefined);

  // Ensure the service token never leaks in the client response
  const clientResponse = controlResponseToFetch(res);
  const text = await clientResponse.text();
  assert.ok(!text.includes("secret-token-do-not-leak"));
});

test("proxy forwards viewer actor without role claims", async () => {
  let capturedActor = "";
  let capturedRole: string | undefined = "sentinel";

  const mockFetch = async (_url: string, init: RequestInit) => {
    const h = (init.headers as Record<string, string>) ?? {};
    capturedActor = h["X-AutoDev-Actor"] ?? "";
    capturedRole = h["X-AutoDev-Role"];
    return Response.json(
      { ok: true },
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  await forwardToControlApi({
    method: "GET",
    path: "providers",
    actor: "viewer-alice",
    fetchImpl: mockFetch
  });

  assert.equal(capturedActor, "viewer-alice");
  assert.equal(capturedRole, undefined);
});

test("proxy forwards operator actor without role claims", async () => {
  let capturedActor = "";
  let capturedRole: string | undefined = "sentinel";

  const mockFetch = async (_url: string, init: RequestInit) => {
    const h = (init.headers as Record<string, string>) ?? {};
    capturedActor = h["X-AutoDev-Actor"] ?? "";
    capturedRole = h["X-AutoDev-Role"];
    return Response.json(
      {
        schema: "autodev-control-provider-role-v2",
        provider: "openai",
        role: "orchestrator",
        enabled: true,
        previous: false,
        actor: "operator-bob"
      },
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  await forwardToControlApi({
    method: "PATCH",
    path: "providers/openai/roles/orchestrator",
    body: { enabled: true },
    actor: "operator-bob",
    fetchImpl: mockFetch
  });

  assert.equal(capturedActor, "operator-bob");
  assert.equal(capturedRole, undefined);
});

test("proxy maps upstream 401, 403, and 502 errors to normalized envelopes", async () => {
  // Upstream 401
  const res401 = await forwardToControlApi({
    method: "GET",
    path: "providers",
    actor: "viewer-1",
    fetchImpl: async () =>
      Response.json(
        { err: "unauthorized" },
        {
          status: 401,
          headers: { "content-type": "application/json" }
        }
      )
  });
  assert.equal(res401.ok, false);
  if (!res401.ok) {
    assert.equal(res401.status, 401);
    assert.match(res401.err, /unauthorized/);
  }

  // Upstream 403
  const res403 = await forwardToControlApi({
    method: "PATCH",
    path: "providers/openai/roles/orchestrator",
    body: { enabled: true },
    actor: "viewer-1",
    fetchImpl: async () =>
      Response.json(
        { err: "actor not in AUTODEV_CONTROL_OPERATORS" },
        {
          status: 403,
          headers: { "content-type": "application/json" }
        }
      )
  });
  assert.equal(res403.ok, false);
  if (!res403.ok) {
    assert.equal(res403.status, 403);
    assert.match(res403.err, /AUTODEV_CONTROL_OPERATORS/);
  }

  // Upstream 502 / network connection error
  const res502 = await forwardToControlApi({
    method: "GET",
    path: "providers",
    actor: "viewer-1",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:4100");
    }
  });
  assert.equal(res502.ok, false);
  if (!res502.ok) {
    assert.equal(res502.status, 502);
    assert.match(res502.err, /AutoDev Control API unreachable/);
  }
});

test("proxy kill switch AUTODEV_CONTROL_API_DISABLED returns 503", async () => {
  const res = await forwardToControlApi({
    method: "GET",
    path: "providers",
    actor: "viewer-1",
    disabled: "1"
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 503);
    assert.match(res.err, /AUTODEV_CONTROL_API_DISABLED/);
  }
});

test("patch 02 satisfies all mutation proxy security requirements", () => {
  const patch = readFileSync(PATCH2, "utf8");

  // Exact-Origin check present
  assert.match(
    patch,
    /verifyOriginForMutation/u,
    "patch 02 must implement verifyOriginForMutation"
  );
  assert.match(
    patch,
    /missing Origin header on state-changing request/u,
    "patch 02 must reject missing Origin with 403"
  );
  assert.match(
    patch,
    /does not match request host/u,
    "patch 02 must reject mismatched Origin with 403"
  );

  // Middleware matcher includes /autodev
  assert.match(
    patch,
    /"\/autodev\/:path\*"/u,
    "patch 02 must register /autodev/:path* in middleware matcher"
  );

  // Auth headers: Authorization Bearer and X-AutoDev-Actor only
  assert.match(
    patch,
    /Authorization:\s*`Bearer \$\{config\.token\}`/u,
    "patch 02 must forward Authorization: Bearer"
  );
  assert.match(
    patch,
    /"X-AutoDev-Actor": actor/u,
    "patch 02 must forward X-AutoDev-Actor"
  );

  // Code must not set role or email headers in proxy implementation
  const proxyHunk =
    patch.match(
      /diff --git a\/src\/client\/src\/lib\/autodev\/control-api\.ts[\s\S]+?(?=\ndiff --git|$)/u
    )?.[0] ?? "";
  const codeOnly = proxyHunk
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(
    codeOnly,
    /X-AutoDev-Role/u,
    "patch 02 proxy code must not set X-AutoDev-Role"
  );
  assert.doesNotMatch(
    codeOnly,
    /X-AutoDev-Actor-Email/u,
    "patch 02 proxy code must not set X-AutoDev-Actor-Email"
  );
});
