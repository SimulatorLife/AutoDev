import assert from "node:assert/strict";
import test from "node:test";

import {
  codexEnvironmentHeaders,
  environmentVariableName,
  resolveEnvironmentHeaders
} from "@simulatorlife/autodev-runtime/shared/mcp-headers";

test("a header value that is exactly one environment reference names its variable", () => {
  assert.equal(
    environmentVariableName("${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}"),
    "GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY"
  );
  assert.equal(environmentVariableName("${_PRIVATE_1}"), "_PRIVATE_1");
  // A literal, a partial reference and a fallback are all values the server
  // receives as they are: only a whole reference can be sourced.
  assert.equal(environmentVariableName("Bearer ${TOKEN}"), null);
  assert.equal(environmentVariableName("${TOKEN:-fallback}"), null);
  assert.equal(environmentVariableName("plain"), null);
});

test("Codex's environment-sourced header table becomes AutoDev's references", () => {
  assert.deepEqual(
    codexEnvironmentHeaders({
      "X-Goog-Api-Key": "GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY"
    }),
    { "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}" }
  );
  assert.deepEqual(codexEnvironmentHeaders({}), {});
  // A table that is not a table of strings is refused rather than guessed at:
  // a half-read table would publish a header nobody declared.
  assert.equal(codexEnvironmentHeaders(null), null);
  assert.equal(codexEnvironmentHeaders(["X-Goog-Api-Key"]), null);
  assert.equal(codexEnvironmentHeaders({ "X-Goog-Api-Key": 42 }), null);
});

test("a header reference is resolved against the environment the caller owns", () => {
  assert.deepEqual(
    resolveEnvironmentHeaders(
      { "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}" },
      { GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY: "secret-value" }
    ),
    { "X-Goog-Api-Key": "secret-value" }
  );
  // A literal header is passed through untouched.
  assert.deepEqual(
    resolveEnvironmentHeaders({ "X-Test": "literal" }, { X_TEST: "ignored" }),
    { "X-Test": "literal" }
  );
  // A reference the environment does not answer is kept as it is: the server
  // then receives a reference rather than a credential, which is the outcome
  // the credential being absent would have produced anyway.
  assert.deepEqual(
    resolveEnvironmentHeaders(
      { "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}" },
      {}
    ),
    { "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}" }
  );
  assert.deepEqual(
    resolveEnvironmentHeaders(
      { "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}" },
      { GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY: "  " }
    ),
    { "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}" }
  );
});
