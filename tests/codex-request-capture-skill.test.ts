import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseTurnsFile,
  type RecorderOptions,
  redactHeaders,
  sseBody,
  type SseEvent,
  startRecorder
} from "../.rulesync/skills/autodev-codex-request-capture/scripts/responses-recorder.ts";

const SKILL_DIR = fileURLToPath(
  new URL("../.rulesync/skills/autodev-codex-request-capture/", import.meta.url)
);
const RECORDER = join(SKILL_DIR, "scripts", "responses-recorder.ts");

type RecorderRun = (url: string, record: string) => Promise<void>;
type RecordedRow = {
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
};

async function withRecorder(
  options: Omit<Partial<RecorderOptions>, "record">,
  run: RecorderRun
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "autodev-recorder-"));
  const record = join(dir, "requests.jsonl");
  const server = await startRecorder({ record, ...options });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run(`http://127.0.0.1:${address.port}`, record);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

const rows = async (record: string): Promise<RecordedRow[]> =>
  (await readFile(record, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedRow);

test("the bundled recorder is valid JavaScript and documents its usage", () => {
  const check = spawnSync(process.execPath, ["--check", RECORDER], {
    encoding: "utf8"
  });
  assert.equal(check.status, 0, check.stderr);
  const usage = spawnSync(process.execPath, [RECORDER], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /--record/);
});

test("every credential-bearing header is redacted before it is recorded", () => {
  const redacted = redactHeaders({
    authorization: "Bearer secret",
    "x-api-key": "secret",
    api_key: "secret",
    cookie: "secret",
    "x-access-token": "secret",
    "content-type": "application/json"
  });
  for (const name of [
    "authorization",
    "x-api-key",
    "api_key",
    "cookie",
    "x-access-token"
  ])
    assert.equal(redacted[name], "<redacted>", name);
  assert.equal(redacted["content-type"], "application/json");
});

test("capture mode records the request, redacts credentials, and answers with a controlled error", async () => {
  await withRecorder({}, async (url, record) => {
    const response = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer capture-secret"
      },
      body: JSON.stringify({
        model: "MiniMax-M3",
        tools: [{ type: "custom", name: "exec" }]
      })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "capture_only");
    const [recorded] = await rows(record);
    assert.ok(recorded);
    assert.equal(recorded.url, "/v1/responses");
    assert.equal(recorded.headers?.authorization, "<redacted>");
    assert.deepEqual(recorded.body?.tools, [{ type: "custom", name: "exec" }]);
    assert.equal(JSON.stringify(recorded).includes("capture-secret"), false);
  });
});

test("replay mode streams scripted turns in order, repeats the last one, and records every follow-up", async () => {
  const turns: SseEvent[][] = [
    [{ type: "response.created", response: { id: "r1" } }],
    [{ type: "response.completed", response: { id: "r2" } }]
  ];
  await withRecorder({ turns }, async (url, record) => {
    const bodies = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turn: index + 1 })
      });
      const contentType = response.headers.get("content-type");
      assert.ok(contentType);
      assert.match(contentType, /text\/event-stream/);
      bodies.push(await response.text());
    }
    assert.equal(bodies[0], sseBody(turns[0]!));
    assert.equal(bodies[1], sseBody(turns[1]!));
    assert.equal(bodies[2], sseBody(turns[1]!));
    assert.deepEqual(
      (await rows(record)).map((row) => row.body?.turn),
      [1, 2, 3]
    );
  });
});

test("the example turns reproduce MiniMax-M3's nested exec_command call, then finish", async () => {
  const fixture = JSON.parse(
    await readFile(
      join(SKILL_DIR, "examples", "exec-command.turns.json"),
      "utf8"
    )
  ) as {
    turns: Array<
      Array<{
        type: string;
        item?: {
          type?: string;
          name?: string;
          id?: string;
          arguments?: string;
        };
      }>
    >;
  };
  const { turns } = fixture;
  assert.equal(turns.length, 2);
  const callEvent = turns[0]?.find(
    (event) =>
      event.type === "response.output_item.done" &&
      event.item?.type === "function_call"
  );
  assert.ok(callEvent?.item);
  const call = callEvent.item;
  assert.equal(call.name, "exec_command");
  assert.ok(call.id);
  assert.match(call.id, /^[0-9a-f]{32}_fc_\d+$/);
  assert.ok(call.arguments);
  assert.deepEqual(JSON.parse(call.arguments), { cmd: "echo autodev-probe" });
  assert.equal(turns[1]?.at(-1)?.type, "response.completed");
  for (const turn of turns)
    assert.equal(turn.at(-1)?.type, "response.completed");
});

test("a turns file that is not { turns: [...] } is refused instead of silently falling back to capture mode", () => {
  const turn = [{ type: "response.created", response: { id: "r1" } }];
  assert.deepEqual(parseTurnsFile({ turns: [turn] }), [turn]);
  // A bare array of turns once ran as capture mode, answering every request with an error.
  assert.throws(() => parseTurnsFile([turn]), /"turns" is a non-empty array/);
  assert.throws(() => parseTurnsFile({ turns: [] }), /non-empty/);
  assert.throws(
    () => parseTurnsFile({ turns: ["not an event array"] }),
    /SSE event arrays/
  );
});
