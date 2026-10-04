import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Claude stream processing remains iterative across a long incremental stream", async () => {
  const lineCount = 2048;
  const expectedText = "x".repeat(lineCount);
  const temp = await mkdtemp(join(tmpdir(), "autodev-claude-stream-"));
  const fakeCli = join(temp, "fake-claude.mjs");
  await writeFile(
    fakeCli,
    String.raw`#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
const lineCount = Number(process.env.CLAUDE_STREAM_TEST_LINES);
for (let index = 0; index < lineCount; index++) {
  process.stdout.write(JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "x" }
    }
  }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 1));
}
process.stdout.write(JSON.stringify({
  type: "result",
  is_error: false,
  result: "x".repeat(lineCount),
  usage: { input_tokens: 5, output_tokens: lineCount }
}) + "\n");
`,
    "utf8"
  );
  await chmod(fakeCli, 0o755);

  const previousCli = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = fakeCli;
  try {
    const { runClaudeStream } =
      await import("../runtime/src/providers/claude.ts");
    const events = [];
    for await (const event of runClaudeStream("prompt", "sonnet", "medium", {
      cwd: temp,
      env: {
        ...process.env,
        CLAUDE_STREAM_TEST_LINES: String(lineCount)
      },
      signal: new AbortController().signal,
      waitingOnCodex: () => false,
      systemPrompt: "",
      turnId: null,
      webSearch: false
    })) {
      events.push(event);
    }

    const textEvents = events.filter((event) => event.kind === "text");
    assert.equal(textEvents.length, lineCount);
    assert.equal(
      textEvents
        .map((event) => (event.kind === "text" ? event.text : ""))
        .join(""),
      expectedText
    );
    assert.deepEqual(events.at(-1), {
      kind: "complete",
      text: expectedText,
      usage: { input_tokens: 5, output_tokens: lineCount }
    });
  } finally {
    if (previousCli === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousCli;
    await rm(temp, { recursive: true, force: true });
  }
});
