import assert from "node:assert/strict";
import { userInfo } from "node:os";
import test from "node:test";

import { claudeQuotaAxiEnvironment } from "../src/providers/claude-credential.ts";
import { keychainAccount } from "../src/shared/runtime-secrets.ts";

test("the Keychain account falls back to the OS account when USER is missing", () => {
  assert.equal(keychainAccount({ USER: "claude-user" }), "claude-user");
  assert.equal(
    keychainAccount({ USER: "", LOGNAME: "root" }),
    userInfo().username
  );
});

test("claudeQuotaAxiEnvironment preserves existing environment when no token is available", () => {
  const environment: NodeJS.ProcessEnv = {
    PATH: "/bin:/usr/bin",
    HOME: "/Users/test",
    USER: "testuser"
  };
  const result = claudeQuotaAxiEnvironment(environment);
  assert.equal(result.PATH, "/bin:/usr/bin");
  assert.equal(result.HOME, "/Users/test");
  assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("claudeQuotaAxiEnvironment injects CLAUDE_CODE_OAUTH_TOKEN when present in environment", () => {
  const environment: NodeJS.ProcessEnv = {
    PATH: "/bin:/usr/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-test-token-12345"
  };
  const result = claudeQuotaAxiEnvironment(environment);
  assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-test-token-12345");
  assert.equal(result.PATH, "/bin:/usr/bin");
});

test("claudeQuotaAxiEnvironment does not mutate the input environment object", () => {
  const environment: NodeJS.ProcessEnv = Object.freeze({
    PATH: "/bin:/usr/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-test-token-immutable"
  });
  const result = claudeQuotaAxiEnvironment(environment);
  assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-test-token-immutable");
  assert.notEqual(result, environment);
});
