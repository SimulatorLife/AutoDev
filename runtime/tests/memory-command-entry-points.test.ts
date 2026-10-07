import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

/**
 * How the memory commands report a configuration failure.
 *
 * These three are what an operator schedules or launches — the MCP server a
 * client spawns, and the two one-shot curator jobs. They had no test at all, and
 * they did not agree: `memory:retention` and `memory:capture` both caught,
 * wrote a single `prefix: message` line to stderr, and set exit code 1, while
 * the MCP entry point did not catch at all. An uncaught rejection from a
 * top-level await printed twelve lines of Node stack trace instead.
 *
 * The stack trace is the whole problem, and it is worse for the MCP server than
 * for a cron job. An MCP host forwards the server's stderr to the model, so a
 * missing `AUTODEV_MEMORY_DATABASE_URL` put Node's internal frames and source
 * locations into the agent's context — on every launch, for a mistake that has a
 * one-sentence answer.
 *
 * Every case here fails during configuration, before any connection is
 * attempted, which is what lets the whole surface be covered without a database.
 * The assertions are about the shape of the report rather than its wording, so
 * the messages can be reworded without this test going stale.
 */

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const COMMANDS = [
  {
    entry: "src/router/memory-mcp-main.ts",
    prefix: "memory-mcp:",
    /** What a launcher with no database URL is told to fix. */
    expected: /database URL/iu
  },
  {
    entry: "src/memory/retention-main.ts",
    prefix: "memory-retention:",
    expected: /AUTODEV_MEMORY_RETENTION_ENABLED/u
  },
  {
    entry: "src/memory/capture-main.ts",
    prefix: "memory-capture:",
    expected: /AUTODEV_MEMORY_CAPTURE_ENABLED/u
  }
] as const;

/**
 * Run a command with the memory configuration blanked.
 *
 * `input: ""` closes stdin so a stdio server that somehow got past configuration
 * would end rather than hanging the suite.
 */
function run(entry: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(PACKAGE_ROOT, entry)], {
    encoding: "utf8",
    timeout: 30_000,
    input: "",
    env: {
      ...process.env,
      AUTODEV_MEMORY_DATABASE_URL: "",
      AUTODEV_MEMORY_WORKSPACE_ID: "",
      AUTODEV_MEMORY_REPOSITORY_ID: "",
      AUTODEV_MEMORY_CAPTURE_ENABLED: "",
      AUTODEV_MEMORY_RETENTION_ENABLED: "",
      AUTODEV_MEMORY_EMBEDDING_MODEL: ""
    }
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

for (const { entry, prefix, expected } of COMMANDS) {
  test(`${entry} reports a configuration failure as one line and exits non-zero`, () => {
    const { status, stderr } = run(entry);
    const lines = stderr.trim().split("\n").filter(Boolean);

    assert.equal(
      status,
      1,
      `${entry} exited ${status}; a misconfigured command must fail loudly`
    );
    assert.equal(
      lines.length,
      1,
      `${entry} wrote ${lines.length} lines to stderr; an operator needs the one line that names the fix`
    );
    assert.match(
      lines[0] ?? "",
      expected,
      `${entry} did not say what is missing`
    );
    assert.ok(
      (lines[0] ?? "").startsWith(prefix),
      `${entry} reported without its ${prefix} prefix, so its output cannot be told apart`
    );

    // The specific regression: a stack trace instead of a sentence. Frame
    // markers and `file://` source locations are what a rejected top-level
    // await leaves behind.
    assert.doesNotMatch(
      stderr,
      /\n\s+at\s/u,
      `${entry} printed a stack frame where an operator wants a sentence`
    );
    assert.doesNotMatch(
      stderr,
      /file:\/\/\/|\.ts:\d+/u,
      `${entry} printed a source location where an operator wants a sentence`
    );
  });
}

test("a configured command that fails still reports one line, not a trace", () => {
  // The same shape from the other direction: an unconfigured command fails on
  // its first required setting, while these reach further in. Whichever setting
  // it stops at, the report has to be the same shape — that is the part an
  // operator's log parser and an MCP host both depend on.
  const result = spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, "src/memory/retention-main.ts")],
    {
      encoding: "utf8",
      timeout: 30_000,
      input: "",
      env: {
        ...process.env,
        AUTODEV_MEMORY_DATABASE_URL: "postgres://memory:memory@127.0.0.1:1/memory",
        AUTODEV_MEMORY_WORKSPACE_ID: "SimulatorLife/AutoDev",
        AUTODEV_MEMORY_REPOSITORY_ID: "SimulatorLife/AutoDev",
        AUTODEV_MEMORY_RETENTION_ENABLED: "1",
        // Retention also demands the task-history grant before it reads the age,
        // so a test that stops at the grant proves nothing about validation.
        AUTODEV_MEMORY_READ_TASK_HISTORY: "1",
        AUTODEV_MEMORY_EXPERIENCE_RETENTION_DAYS: "not-a-number",
        AUTODEV_MEMORY_CAPTURE_ENABLED: "",
        AUTODEV_MEMORY_EMBEDDING_MODEL: ""
      }
    }
  );
  const lines = (result.stderr ?? "").trim().split("\n").filter(Boolean);

  assert.equal(result.status, 1, "an invalid retention age must fail the command");
  assert.equal(
    lines.length,
    1,
    `a validation failure printed ${lines.length} lines: ${(result.stderr ?? "").slice(0, 200)}`
  );
  assert.match(lines[0] ?? "", /retention days/u);
  assert.doesNotMatch(result.stderr ?? "", /\n\s+at\s/u);
});