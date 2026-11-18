/**
 * The patched quota-axi reads Claude's quota through Claude Code inference when
 * Anthropic's usage endpoint answers the bridge's inference-only env token with
 * a 429.
 *
 * The endpoint refuses that token either with a 403 scope denial or with a 429
 * it never lifts. Unpatched quota-axi took the inference reading only for the
 * 403, so the Console showed "Quota rate limited" for Claude indefinitely
 * (`patches/quota-axi@0.1.69.patch`). The test runs the real quota-axi binary
 * against a stubbed usage endpoint and a fake `claude` that prints the debug
 * response block quota-axi parses; nothing reaches a vendor or the Keychain.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { QuotaAxiResponse } from "quota-axi";

const execFileAsync = promisify(execFile);
const quotaAxi = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  ".bin",
  "quota-axi"
);

const FIVE_HOUR_RESET_S = Math.floor(Date.now() / 1000) + 3600;
const SEVEN_DAY_RESET_S = Math.floor(Date.now() / 1000) + 3 * 86_400;

/** Every vendor request fails; the usage endpoint answers 429 as observed. */
const FETCH_STUB = `
globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/api/oauth/usage")) {
    return new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
  }
  return new Response("{}", { status: 404 });
};
`;

/** Claude Code's API debug block, as `--debug api` writes it. */
const FAKE_CLAUDE = `#!/bin/sh
cat >&2 <<EOF
[log_test] response start {
  status: 200,
  headers: {
    'anthropic-ratelimit-unified-5h-utilization': '0.25',
    'anthropic-ratelimit-unified-5h-reset': '${FIVE_HOUR_RESET_S}',
    'anthropic-ratelimit-unified-7d-utilization': '0.4',
    'anthropic-ratelimit-unified-7d-reset': '${SEVEN_DAY_RESET_S}'
  }
}
EOF
echo OK
`;

async function readClaude(args: readonly string[]) {
  const root = mkdtempSync(path.join(tmpdir(), "quota-axi-claude-"));
  try {
    const bin = path.join(root, "bin");
    const preload = path.join(root, "fetch-stub.mjs");
    writeFileSync(preload, FETCH_STUB);
    mkdirSync(bin);
    writeFileSync(path.join(bin, "claude"), FAKE_CLAUDE);
    // No Keychain item: the env token is the only credential.
    writeFileSync(path.join(bin, "security"), "#!/bin/sh\nexit 44\n");
    chmodSync(path.join(bin, "claude"), 0o755);
    chmodSync(path.join(bin, "security"), 0o755);
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
        path.delimiter
      ),
      NODE_OPTIONS: `--import=${preload}`,
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-inference-only"
    };
    const { stdout } = await execFileAsync(
      quotaAxi,
      ["--json", "--no-credential-refresh", "--provider=claude", ...args],
      { env, encoding: "utf8" }
    ).catch((error: { code?: number; stdout?: string }) => {
      // quota-axi exits 1 when every provider failed, still printing its report.
      if (error.code !== 1 || error.stdout === undefined) throw error;
      return { stdout: error.stdout };
    });
    const report = JSON.parse(stdout) as QuotaAxiResponse;
    const claude = report.providers.find((entry) => entry.provider === "claude");
    assert.ok(claude, "quota-axi reports Claude");
    return claude;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a 429 from the usage endpoint falls through to the inference reading", async () => {
  const claude = await readClaude(["--allow-claude-inference"]);

  assert.equal(claude.state.status, "fresh");
  assert.deepEqual(
    claude.windows.map((window) => [window.id, window.percentRemaining]),
    [
      ["five_hour", 75],
      ["seven_day", 60]
    ]
  );
});

test("without inference allowed, a 429 is still reported as rate limited", async () => {
  const claude = await readClaude([]);

  assert.equal(claude.state.status, "rate_limited");
  assert.equal(claude.windows.length, 0);
  assert.ok(claude.state.retryAfter, "the vendor's retry moment is kept");
});
