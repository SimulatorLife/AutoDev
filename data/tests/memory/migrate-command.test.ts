import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

/**
 * How `memory:migrate` reports a failure.
 *
 * The sibling command in `runtime` — the retention and capture jobs, and the MCP
 * server — all catch, write one `prefix: message` line to stderr, and set exit
 * code 1. This entry point did not, so a rejected top-level await printed ten
 * lines of stack trace and buried the one sentence `migrateMemoryDatabase`
 * already had for exactly this case.
 *
 * A migration is the command most likely to be run against an environment that
 * is not configured yet — that is often why someone is running it — so this
 * message is one an operator reads on its first attempt rather than after
 * debugging something.
 *
 * No database is involved: every case here fails during configuration, before a
 * pool is built.
 */

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function migrate(databaseUrl: string | undefined): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (databaseUrl === undefined) delete env.AUTODEV_MEMORY_DATABASE_URL;
  else env.AUTODEV_MEMORY_DATABASE_URL = databaseUrl;
  const result = spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, "src/memory/migrate.ts")],
    {
      encoding: "utf8",
      timeout: 30_000,
      input: "",
      env
    }
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

test("a missing database URL is one line naming the variable, and exits non-zero", () => {
  const { status, stdout, stderr } = migrate(undefined);
  const lines = stderr.trim().split("\n").filter(Boolean);

  assert.equal(status, 1, "a migration that cannot start must fail loudly");
  assert.equal(
    lines.length,
    1,
    `wrote ${lines.length} lines to stderr: ${stderr.slice(0, 240)}`
  );
  assert.ok(
    (lines[0] ?? "").startsWith("memory-migrate:"),
    `reported without its prefix: ${JSON.stringify(lines[0] ?? "")}`
  );
  assert.match(
    lines[0] ?? "",
    /AUTODEV_MEMORY_DATABASE_URL/u,
    "the line did not name the variable to set"
  );
  assert.doesNotMatch(
    stderr,
    /\n\s+at\s/u,
    "printed a stack frame where an operator wants a sentence"
  );
  assert.doesNotMatch(stderr, /file:\/\/\/|\.ts:\d+/u);
  assert.equal(
    stdout,
    "",
    "a failed migration wrote to stdout as if it had run"
  );
});

test("a blank database URL is treated as missing, not as a connection string", () => {
  // `pg` would accept a blank string as a connection string with defaults and
  // then fail somewhere much later and much less legibly. The blank is a
  // configuration mistake and has to read like one.
  const { status, stderr } = migrate("   ");

  assert.equal(status, 1);
  assert.match(stderr, /AUTODEV_MEMORY_DATABASE_URL/u);
  assert.doesNotMatch(stderr, /\n\s+at\s/u);
});

test("an unusable database URL fails through the same one-line report", () => {
  // A URL that parses but names nothing listening. The connection attempt is
  // where this fails, so it exercises the catch rather than the guard — and the
  // two must not report differently, or the shape is only half a contract.
  const { status, stderr } = migrate(
    "postgres://memory:memory@127.0.0.1:1/memory"
  );

  assert.equal(status, 1, "an unreachable database must fail the migration");
  const lines = stderr.trim().split("\n").filter(Boolean);
  assert.equal(
    lines.length,
    1,
    `wrote ${lines.length} lines to stderr: ${stderr.slice(0, 240)}`
  );
  assert.ok((lines[0] ?? "").startsWith("memory-migrate:"));
  assert.doesNotMatch(stderr, /\n\s+at\s/u);
});
