import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import { createAgentActivityTracker } from "@simulatorlife/autodev-runtime/agents";
import {
  ConcurrencyManager,
  parseConcurrencyConfig,
  PROCESS_FALLBACK_SESSION_KEY
} from "@simulatorlife/autodev-runtime/router/concurrency";

test("parseConcurrencyConfig parses multiline and inline tables and rejects legacy max_threads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "concurrency-test-"));
  const file = join(dir, "config.toml");
  try {
    await writeFile(
      file,
      "[agents]\nenabled = true\nmax_concurrent_threads_per_session = 3\n"
    );
    assert.deepEqual(parseConcurrencyConfig(file), {
      file,
      maxConcurrentThreadsPerSession: 3
    });

    await writeFile(
      file,
      "agents = { max_concurrent_threads_per_session = 5 }\n"
    );
    assert.deepEqual(parseConcurrencyConfig(file), {
      file,
      maxConcurrentThreadsPerSession: 5
    });

    await writeFile(file, "[agents]\nmax_threads = 10\n");
    assert.deepEqual(parseConcurrencyConfig(file), {
      file,
      maxConcurrentThreadsPerSession: null
    });

    await writeFile(file, "[agents]\nmax_concurrent_threads_per_session = 0\n");
    assert.deepEqual(parseConcurrencyConfig(file), {
      file,
      maxConcurrentThreadsPerSession: 0
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseConcurrencyConfig reads every valid TOML integer spelling", async () => {
  // TOML integers are not just run-of-digits: `_` is a legal digit separator
  // and `0x`/`0o`/`0b` are legal bases. Reading only `\d+` and stopping there
  // silently capped `1_000` at a single thread, which reads as a plausible
  // configuration rather than a parse failure.
  const dir = await mkdtemp(join(tmpdir(), "concurrency-integer-test-"));
  const file = join(dir, "config.toml");
  try {
    const cases: [string, number][] = [
      ["1_000", 1000],
      ["12_345", 12_345],
      ["0x40", 64],
      ["0o17", 15],
      ["0b1010", 10],
      ["8 # eight", 8],
      ["1_000_000", 1_000_000]
    ];
    for (const [token, expected] of cases) {
      await writeFile(
        file,
        `[agents]\nmax_concurrent_threads_per_session = ${token}\n`
      );
      assert.deepEqual(
        parseConcurrencyConfig(file),
        { file, maxConcurrentThreadsPerSession: expected },
        `${token} should parse as ${expected}`
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseConcurrencyConfig reads full TOML documents around the agents table", async () => {
  const dir = await mkdtemp(join(tmpdir(), "concurrency-toml-test-"));
  const file = join(dir, "config.toml");
  try {
    const cases: [string, string, number | null][] = [
      [
        "indented multiline table with comments and nested role tables",
        "  [agents]\n  # cap\n  max_concurrent_threads_per_session = 4 # four\n\n  [agents.explorer]\n  max_concurrent_threads_per_session = 99\n",
        4
      ],
      [
        "inline table with nested roles declared before the key",
        'agents = { explorer = { description = "}{" }, max_concurrent_threads_per_session = 6 }\n',
        6
      ],
      ["dotted keys", "agents.max_concurrent_threads_per_session = 7\n", 7],
      [
        "key inside another table is ignored",
        "[other]\nmax_concurrent_threads_per_session = 9\n",
        null
      ],
      ["empty file", "", null],
      ["agents table without the key", "[agents]\nmax_threads = 3\n", null],
      [
        "largest safe integer",
        "[agents]\nmax_concurrent_threads_per_session = 9007199254740991\n",
        Number.MAX_SAFE_INTEGER
      ],
      [
        "key text inside a string value is not the key",
        '[agents]\nnote = "max_concurrent_threads_per_session = 5"\n',
        null
      ]
    ];
    for (const [name, source, expected] of cases) {
      await writeFile(file, source);
      assert.deepEqual(
        parseConcurrencyConfig(file),
        { file, maxConcurrentThreadsPerSession: expected },
        name
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseConcurrencyConfig reports malformed or unusable declarations as unread", async () => {
  // A TOML syntax error means nothing in the file can be trusted, and a
  // well-formed value that is not a usable limit is not a confirmed absent
  // cap either: both are "nobody knows", so both are `undefined`.
  const dir = await mkdtemp(join(tmpdir(), "concurrency-unread-test-"));
  const file = join(dir, "config.toml");
  try {
    const sources: [string, string][] = [
      ["malformed TOML", "[agents\nmax_concurrent_threads_per_session = 2\n"],
      [
        "bareword value",
        "[agents]\nmax_concurrent_threads_per_session = not_a_number\n"
      ],
      [
        "truncated integer token",
        "[agents]\nmax_concurrent_threads_per_session = 12abc\n"
      ],
      [
        "string value",
        '[agents]\nmax_concurrent_threads_per_session = "two"\n'
      ],
      ["float value", "[agents]\nmax_concurrent_threads_per_session = 2.5\n"],
      [
        "boolean value",
        "[agents]\nmax_concurrent_threads_per_session = true\n"
      ],
      ["negative value", "[agents]\nmax_concurrent_threads_per_session = -1\n"],
      [
        "integer beyond the safe range",
        "[agents]\nmax_concurrent_threads_per_session = 9007199254740992\n"
      ],
      ["agents that is not a table", 'agents = "many"\n'],
      ["agents that is an array of tables", "[[agents]]\nname = 1\n"]
    ];
    for (const [name, source] of sources) {
      await writeFile(file, source);
      const parsed = parseConcurrencyConfig(file);
      assert.equal(parsed.maxConcurrentThreadsPerSession, undefined, name);
      assert.equal(
        Object.hasOwn(parsed, "maxConcurrentThreadsPerSession"),
        true,
        name
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseConcurrencyConfig warnings never echo config content from TOML parse errors", async () => {
  const sentinel = "SECRET_SENTINEL_9f3a1c";
  const dir = await mkdtemp(join(tmpdir(), "concurrency-redact-test-"));
  const file = join(dir, "config.toml");
  const lines: string[] = [];
  const write = mock.method(process.stderr, "write", (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await writeFile(
      file,
      `[provider]
api_key = ${sentinel} oops
[agents]
max_concurrent_threads_per_session = 2
`
    );
    const parsed = parseConcurrencyConfig(file);
    assert.equal(parsed.maxConcurrentThreadsPerSession, undefined);
    const output = lines.join("");
    assert.match(output, /could not read Codex concurrency config from/);
    assert.equal(output.includes(sentinel), false);
  } finally {
    write.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseConcurrencyConfig reports filesystem failures by error code only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "concurrency-fscode-test-"));
  const file = join(dir, "config.toml");
  const lines: string[] = [];
  const write = mock.method(process.stderr, "write", (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await mkdir(file);
    assert.equal(
      parseConcurrencyConfig(file).maxConcurrentThreadsPerSession,
      undefined
    );
    const output = lines.join("");
    assert.match(output, /filesystem error EISDIR/);
    assert.equal(output.includes("illegal operation"), false);
  } finally {
    write.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a config file nobody could read is not a config file that declares no limit", async () => {
  // The file is there and could not be read, so nobody knows what it
  // declares. `null` is a file that was read and declares no limit, and the
  // two are different claims: one is a deployment that runs without a cap on
  // purpose, the other is a cap the operator configured that has silently
  // stopped being enforced.
  const dir = await mkdtemp(join(tmpdir(), "concurrency-unreadable-test-"));
  const file = join(dir, "config.toml");
  try {
    // A directory where the file should be: the path is there, and the read
    // fails. That is the shape of a file that exists and cannot be read.
    await mkdir(file);
    const parsed = parseConcurrencyConfig(file);
    assert.equal(parsed.maxConcurrentThreadsPerSession, undefined);
    // The key is still there, so the field is a fact about the read rather
    // than a field nobody filled in.
    assert.equal(Object.hasOwn(parsed, "maxConcurrentThreadsPerSession"), true);

    const manager = new ConcurrencyManager({
      agentActivity: createAgentActivityTracker(),
      initialConfig: parsed
    });
    const status = manager.concurrencyStatus();
    // Nothing declared a limit, so nothing is enforced...
    assert.equal(status.effectivePerSessionLimit, null);
    // ...and the status does not claim the file declared that.
    assert.equal(
      Object.hasOwn(status, "maxConcurrentThreadsPerSession"),
      false
    );
    // The wire carries the field only when the file was read: an absent key
    // is what "nobody read it" looks like to a consumer of the payload.
    assert.equal(
      JSON.stringify(status).includes("maxConcurrentThreadsPerSession"),
      false
    );
    // Nothing that could be read declared a limit, so the router's default is
    // what is in force -- and the status says that is where it came from.
    assert.equal(status.configSource, "default");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the status names where the limit in force came from", () => {
  // The operator reads this word next to the limit, so it has to say whether
  // the cap is a stored override, the config file's own limit, or nothing
  // that could be read declaring one. It used to name the config file's
  // location instead, so the word the Console reads was never published.
  const configured = new ConcurrencyManager({
    agentActivity: createAgentActivityTracker(),
    configFileSource: "env_override",
    initialConfig: {
      file: "/nonexistent/autodev-codex-concurrency.toml",
      maxConcurrentThreadsPerSession: 8
    }
  });
  const configuredStatus = configured.concurrencyStatus();
  assert.equal(configuredStatus.configSource, "config_file");
  // Which file was read is a different fact, and it travels under its own
  // name rather than under the limit's source.
  assert.equal(configuredStatus.configFileSource, "env_override");

  const undeclared = new ConcurrencyManager({
    agentActivity: createAgentActivityTracker(),
    configFileSource: "default_codex_home",
    initialConfig: {
      file: "/nonexistent/autodev-codex-concurrency.toml",
      maxConcurrentThreadsPerSession: null
    }
  });
  assert.equal(undeclared.concurrencyStatus().configSource, "default");
  assert.equal(
    undeclared.concurrencyStatus().configFileSource,
    "default_codex_home"
  );

  // A stored override is the limit in force, and it says so.
  const overridden = new ConcurrencyManager({
    agentActivity: createAgentActivityTracker(),
    configFileSource: "default_codex_home",
    initialConfig: {
      file: "/nonexistent/autodev-codex-concurrency.toml",
      maxConcurrentThreadsPerSession: 8
    }
  });
  overridden.setMaxConcurrentThreadsPerSession(3);
  const overriddenStatus = overridden.concurrencyStatus();
  assert.equal(overriddenStatus.configSource, "stored_override");
  assert.equal(overriddenStatus.effectivePerSessionLimit, 3);
  // The config file still declares eight, and that is still published beside
  // the override rather than being overwritten by it.
  assert.equal(overriddenStatus.maxConcurrentThreadsPerSession, 8);

  // Clearing the override hands the limit back to the config file.
  overridden.clearStoredLimit();
  assert.equal(overridden.concurrencyStatus().configSource, "config_file");
  assert.equal(overridden.concurrencyStatus().effectivePerSessionLimit, 8);
});

test("ConcurrencyManager admits and releases subagent slots up to configured limit", () => {
  const activity = createAgentActivityTracker();
  const manager = new ConcurrencyManager({
    agentActivity: activity,
    initialConfig: {
      file: "/fake/config.toml",
      maxConcurrentThreadsPerSession: 2
    }
  });

  assert.equal(manager.effectivePerSessionLimit(), 2);
  assert.equal(manager.tryAcquireSubagentSlot("session-1"), null);
  assert.equal(manager.tryAcquireSubagentSlot("session-1"), null);
  assert.equal(
    manager.tryAcquireSubagentSlot("session-1"),
    "max_concurrent_threads_per_session"
  );

  // Another session has its own limit budget
  assert.equal(manager.tryAcquireSubagentSlot("session-2"), null);

  // Status check
  const status = manager.concurrencyStatus();
  assert.equal(status.maxConcurrentThreadsPerSession, 2);
  assert.equal(status.activeSubagentThreads, 3);
  assert.equal(status.activeSessions, 2);

  // Release a slot
  manager.releaseSubagentSlot("session-1");
  assert.equal(manager.tryAcquireSubagentSlot("session-1"), null);

  // Denial recording
  manager.recordConcurrencyDenial("max_concurrent_threads_per_session");
  assert.equal(manager.telemetry.denials, 1);
  assert.equal(
    manager.telemetry.denialsByReason.max_concurrent_threads_per_session,
    1
  );

  // Reset
  manager.resetConcurrencyTelemetry();
  assert.equal(manager.telemetry.denials, 0);
  assert.equal(manager.activeSubagentThreads(), 0);
});

test("ConcurrencyManager supports process-fallback session key", () => {
  const activity = createAgentActivityTracker();
  const manager = new ConcurrencyManager({
    agentActivity: activity,
    initialConfig: {
      file: "/fake/config.toml",
      maxConcurrentThreadsPerSession: 1
    }
  });

  assert.equal(
    manager.tryAcquireSubagentSlot(PROCESS_FALLBACK_SESSION_KEY),
    null
  );
  const status = manager.concurrencyStatus();
  assert.equal(status.processFallbackActiveThreads, 1);
  assert.equal(status.processFallbackEnforcement, true);

  manager.releaseSubagentSlot(PROCESS_FALLBACK_SESSION_KEY);
  assert.equal(manager.concurrencyStatus().processFallbackActiveThreads, 0);
});

test("ConcurrencyManager restores serialized telemetry", () => {
  const activity = createAgentActivityTracker();
  const manager = new ConcurrencyManager({
    agentActivity: activity,
    initialConfig: {
      file: "/fake/config.toml",
      maxConcurrentThreadsPerSession: 2
    }
  });

  manager.restoreTelemetry({
    denials: 4,
    denialsByReason: { max_concurrent_threads_per_session: 4 },
    lastDenial: {
      timestamp: "2026-09-16T12:00:00.000Z",
      reason: "max_concurrent_threads_per_session",
      requestId: "req-restored"
    }
  });

  assert.equal(manager.telemetry.denials, 4);
  assert.equal(
    manager.telemetry.denialsByReason.max_concurrent_threads_per_session,
    4
  );
  assert.equal(manager.telemetry.lastDenial?.requestId, "req-restored");

  const status = manager.concurrencyStatus();
  assert.equal(status.denials, 4);
  assert.equal(status.lastDenial?.requestId, "req-restored");
});
