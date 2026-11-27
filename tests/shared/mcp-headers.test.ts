import assert from "node:assert/strict";
import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  codexEnvironmentHeaders,
  environmentVariableName,
  type RemoteBackendSpec,
  resolveRemoteMcpHeaders} from "@simulatorlife/autodev-runtime/shared/mcp-headers";

const URL = "https://mcp.example.invalid/mcp";

test("a whole environment reference names exactly one variable", () => {
  assert.equal(environmentVariableName("${_PRIVATE_1}"), "_PRIVATE_1");
  assert.equal(environmentVariableName("Bearer ${TOKEN}"), null);
  assert.equal(environmentVariableName("${TOKEN:-fallback}"), null);
  assert.equal(environmentVariableName("plain"), null);
});

test("Codex's environment header table preserves references without resolving credentials", () => {
  assert.deepEqual(codexEnvironmentHeaders({ "X-Api-Key": "FIXTURE_TOKEN" }), {
    "X-Api-Key": "${FIXTURE_TOKEN}"
  });
  assert.deepEqual(codexEnvironmentHeaders({}), {});
  for (const invalid of [
    null,
    ["X-Api-Key"],
    { "X-Api-Key": 42 },
    { "X-Api-Key": "TOKEN:-fallback" },
    { "X-Api-Key": "" },
    { "Invalid Name": "TOKEN" },
    { "X-Key": "TOKEN", "x-key": "OTHER_TOKEN" },
    { "MCP-Session-Id": "TOKEN" }
  ]) {
    assert.equal(codexEnvironmentHeaders(invalid), null);
  }
});

test("remote credentials resolve only against the backend environment and existing secret reader", () => {
  const temporary = mkdtempDisposableSync(
    path.join(tmpdir(), "autodev-mcp-header-")
  );
  try {
    const secretFile = path.join(temporary.path, "fixture.env");
    writeFileSync(secretFile, "FIXTURE_FILE_KEY=fixture-file-value\n", {
      mode: 0o600
    });
    const environment = {
      AUTODEV_OPENLIT_SECRET_FILE: secretFile,
      FIXTURE_BEARER: "fixture-bearer",
      FIXTURE_API_KEY: "fixture-api-key"
    };
    const spec = {
      url: URL,
      bearer_token_env_var: "FIXTURE_BEARER",
      http_headers: {
        "X-Api-Key": "${FIXTURE_API_KEY}",
        "X-File-Key": "${FIXTURE_FILE_KEY}",
        "X-Template": "prefix ${FIXTURE_API_KEY}",
        "X-Literal": "literal"
      }
    };
    const headers = resolveRemoteMcpHeaders(spec, "fixture", environment);
    assert.ok(headers instanceof Headers);
    assert.equal(headers.get("authorization"), "Bearer fixture-bearer");
    assert.equal(headers.get("x-api-key"), "fixture-api-key");
    assert.equal(headers.get("x-file-key"), "fixture-file-value");
    assert.equal(headers.get("x-template"), "prefix fixture-api-key");
    assert.equal(headers.get("x-literal"), "literal");
    assert.equal(spec.http_headers["X-Api-Key"], "${FIXTURE_API_KEY}");
    assert.equal(environment.FIXTURE_API_KEY, "fixture-api-key");
  } finally {
    temporary.remove();
  }
});

test("missing and malformed remote credential references fail closed", () => {
  const temporary = mkdtempDisposableSync(
    path.join(tmpdir(), "autodev-mcp-header-")
  );
  try {
    const environment: NodeJS.ProcessEnv = Object.assign(
      Object.create({ FIXTURE_INHERITED: "not-an-owned-credential" }),
      {
        AUTODEV_OPENLIT_SECRET_FILE: path.join(temporary.path, "absent.env"),
        FIXTURE_EMPTY: " "
      }
    );
    for (const variable of [
      "FIXTURE_MISSING",
      "FIXTURE_EMPTY",
      "FIXTURE_INHERITED"
    ]) {
      assert.throws(
        () =>
          resolveRemoteMcpHeaders(
            {
              url: URL,
              http_headers: { "X-Key": "${" + variable + "}" }
            },
            "fixture",
            environment
          ),
        /Missing credential for remote MCP server fixture/u
      );
      assert.throws(
        () =>
          resolveRemoteMcpHeaders(
            {
              url: URL,
              bearer_token_env_var: variable
            },
            "fixture",
            environment
          ),
        /Missing credential for remote MCP server fixture/u
      );
    }
    for (const invalid of [
      "${TOKEN:-fallback}",
      "${TOKEN",
      "${}",
      "${9TOKEN}",
      "${TOKEN NAME}"
    ]) {
      assert.throws(
        () =>
          resolveRemoteMcpHeaders(
            {
              url: URL,
              http_headers: { "X-Key": invalid }
            },
            "fixture",
            environment
          ),
        /Invalid remote MCP credential reference/u
      );
    }
    assert.throws(
      () =>
        resolveRemoteMcpHeaders(
          { url: URL, bearer_token_env_var: "" },
          "fixture",
          environment
        ),
      /Invalid remote MCP credential reference/u
    );
  } finally {
    temporary.remove();
  }
});

test("remote declarations cannot override transport state, merge duplicate headers, or leak invalid values", () => {
  const sentinel = "fixture-private-marker";
  const environment = {
    FIXTURE_TOKEN: "valid-fixture",
    FIXTURE_BAD: sentinel + "\r\ninjected"
  };
  const invalid: RemoteBackendSpec[] = [
    {
      url: URL,
      bearer_token_env_var: "FIXTURE_TOKEN",
      http_headers: { authorization: sentinel }
    },
    { url: URL, http_headers: { "X-Key": sentinel, "x-key": "duplicate" } },
    { url: URL, http_headers: { "Invalid Name": sentinel } },
    { url: URL, http_headers: { "X-Key": "${FIXTURE_BAD}" } },
    { url: URL, http_headers: { "X-Key": sentinel + "\r\ninjected" } },
    ...[
      "Mcp-Session-Id",
      "MCP-Protocol-Version",
      "Last-Event-ID",
      "Host",
      "Content-Length",
      "Content-Type",
      "Accept",
      "Transfer-Encoding"
    ].map((name) => ({ url: URL, http_headers: { [name]: sentinel } }))
  ];
  for (const spec of invalid) {
    assert.throws(
      () => resolveRemoteMcpHeaders(spec, "fixture", environment),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "Invalid or conflicting remote MCP header declaration." &&
        error.cause === undefined &&
        !String(error).includes(sentinel)
    );
  }
  assert.equal(
    resolveRemoteMcpHeaders(
      {
        url: URL,
        http_headers: { Authorization: "Bearer explicit-fixture" }
      },
      "fixture",
      environment
    ).get("Authorization"),
    "Bearer explicit-fixture"
  );
});
