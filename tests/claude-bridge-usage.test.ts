import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, after } from "node:test";

/**
 * The Claude bridge's token reporting.
 *
 * The bridge used to read the CLI's result event's `usage` and nothing else,
 * so a turn whose result carried `modelUsage` -- the name the CLI sends when
 * it names the model it ran on -- reported no tokens at all, and the Usage
 * token and cost panels read as if the provider had consumed nothing.
 *
 * The bridge resolves the CLI path once, when its module is first imported,
 * so the fake CLI is installed before that import and every case tells it
 * which events to emit through the environment.
 */
const FAKE_CLI = String.raw`#!/usr/bin/env node
import fs from "node:fs";
const fixture = JSON.parse(fs.readFileSync(process.env.CLAUDE_USAGE_FIXTURE, "utf8"));
for (const event of fixture.events || []) process.stdout.write(JSON.stringify(event) + "\n");
`;

let temp = "";
let fakeCli = "";

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "autodev-claude-usage-"));
  fakeCli = join(temp, "fake-claude.mjs");
  await writeFile(fakeCli, FAKE_CLI, "utf8");
  await chmod(fakeCli, 0o755);
  process.env.CLAUDE_BIN = fakeCli;
});

after(async () => {
  delete process.env.CLAUDE_BIN;
  if (temp) await rm(temp, { recursive: true, force: true });
});

async function withBridge(
  events: unknown[],
  run: (options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
  }) => Promise<void>
): Promise<void> {
  const fixture = join(temp, `fixture-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(fixture, JSON.stringify({ events }), "utf8");
  try {
    await run({
      cwd: temp,
      env: { ...process.env, CLAUDE_USAGE_FIXTURE: fixture },
      signal: new AbortController().signal
    });
  } finally {
    await rm(fixture, { force: true });
  }
}

async function collect(
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
  }
): Promise<unknown[]> {
  const { runClaudeStream } = await import("../runtime/src/providers/claude.ts");
  const events: unknown[] = [];
  for await (const event of runClaudeStream(
    [{ type: "text", text: "prompt" }],
    "sonnet",
    "medium",
    {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      waitingOnCodex: () => false,
      systemPrompt: "",
      turnId: null,
      webSearch: false
    }
  )) {
    events.push(event);
  }
  return events;
}

test("the Claude bridge reads the token counts the CLI reports under modelUsage", async () => {
  // The CLI names the models a turn used and reports each one's counts, so a
  // turn that ran on more than one model has more than one set to add up.
  await withBridge(
    [
      {
        type: "result",
        is_error: false,
        result: "done",
        modelUsage: {
          "claude-opus-5-5": {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 1
          },
          "claude-sonnet-5-5": {
            inputTokens: 2,
            outputTokens: 1,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 0
          }
        }
      }
    ],
    async (options) => {
      const events = await collect(options);
      assert.deepEqual(events.at(-1), {
        kind: "complete",
        text: "done",
        usage: {
          input_tokens: 48,
          output_tokens: 5,
          cache_read_tokens: 35,
          cache_creation_tokens: 1
        }
      });
    }
  );
});

test("the Claude bridge reads a flat modelUsage the CLI reports", async () => {
  await withBridge(
    [
      {
        type: "result",
        is_error: false,
        result: "done",
        modelUsage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 50
        }
      }
    ],
    async (options) => {
      const events = await collect(options);
      assert.deepEqual(events.at(-1), {
        kind: "complete",
        text: "done",
        usage: {
          input_tokens: 650,
          output_tokens: 20,
          cache_read_tokens: 500,
          cache_creation_tokens: 50
        }
      });
    }
  );
});

test("the Claude bridge still reads the usage the CLI reports under usage", async () => {
  await withBridge(
    [
      {
        type: "result",
        is_error: false,
        result: "done",
        usage: {
          input_tokens: 9,
          output_tokens: 4,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        }
      }
    ],
    async (options) => {
      const events = await collect(options);
      assert.deepEqual(events.at(-1), {
        kind: "complete",
        text: "done",
        usage: {
          input_tokens: 9,
          output_tokens: 4,
          cache_read_tokens: 0,
          cache_creation_tokens: 0
        }
      });
    }
  );
});

test("the Claude bridge reports the finished message's usage before the turn ends", async () => {
  // A response that carries a tool call ends when the message ends, long
  // before the CLI's own result event arrives, so the message's own usage is
  // the only place those tokens can be reported from. Without it every
  // tool-calling response reported no tokens at all.
  await withBridge(
    [
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 50
          }
        }
      },
      {
        type: "result",
        is_error: false,
        result: "done",
        modelUsage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 50
        }
      }
    ],
    async (options) => {
      const events = await collect(options);
      const usage = events.find(
        (event) => (event as { kind?: string }).kind === "usage"
      );
      assert.deepEqual(usage, {
        kind: "usage",
        usage: {
          input_tokens: 650,
          output_tokens: 20,
          cache_read_tokens: 500,
          cache_creation_tokens: 50
        }
      });
      assert.deepEqual(events.at(-1), {
        kind: "complete",
        text: "done",
        usage: {
          input_tokens: 650,
          output_tokens: 20,
          cache_read_tokens: 500,
          cache_creation_tokens: 50
        }
      });
    }
  );
});
