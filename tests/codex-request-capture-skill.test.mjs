import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { redactHeaders, sseBody, startRecorder } from "../.rulesync/skills/autodev-codex-request-capture/scripts/responses-recorder.mjs";

const SKILL_DIR = fileURLToPath(new URL("../.rulesync/skills/autodev-codex-request-capture/", import.meta.url));
const RECORDER = join(SKILL_DIR, "scripts", "responses-recorder.mjs");

async function withRecorder(options, run) {
  const dir = await mkdtemp(join(tmpdir(), "autodev-recorder-"));
  const record = join(dir, "requests.jsonl");
  const server = await startRecorder({ record, ...options });
  try {
    await run(`http://127.0.0.1:${server.address().port}`, record);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

const rows = async (record) => (await readFile(record, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("the bundled recorder is valid JavaScript and documents its usage", () => {
  const check = spawnSync(process.execPath, [ "--check", RECORDER ], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const usage = spawnSync(process.execPath, [ RECORDER ], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /--record/);
});

test("every credential-bearing header is redacted before it is recorded", () => {
  const redacted = redactHeaders({ authorization: "Bearer secret", "x-api-key": "secret", "api_key": "secret", cookie: "secret", "x-access-token": "secret", "content-type": "application/json" });
  for (const name of [ "authorization", "x-api-key", "api_key", "cookie", "x-access-token" ]) assert.equal(redacted[ name ], "<redacted>", name);
  assert.equal(redacted[ "content-type" ], "application/json");
});

test("capture mode records the request, redacts credentials, and answers with a controlled error", async () => {
  await withRecorder({}, async (url, record) => {
    const response = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer capture-secret" },
      body: JSON.stringify({ model: "MiniMax-M3", tools: [ { type: "custom", name: "exec" } ] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "capture_only");
    const [ recorded ] = await rows(record);
    assert.equal(recorded.url, "/v1/responses");
    assert.equal(recorded.headers.authorization, "<redacted>");
    assert.deepEqual(recorded.body.tools, [ { type: "custom", name: "exec" } ]);
    assert.equal(JSON.stringify(recorded).includes("capture-secret"), false);
  });
});

test("replay mode streams scripted turns in order, repeats the last one, and records every follow-up", async () => {
  const turns = [ [ { type: "response.created", response: { id: "r1" } } ], [ { type: "response.completed", response: { id: "r2" } } ] ];
  await withRecorder({ turns }, async (url, record) => {
    const bodies = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turn: index + 1 }) });
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      bodies.push(await response.text());
    }
    assert.equal(bodies[ 0 ], sseBody(turns[ 0 ]));
    assert.equal(bodies[ 1 ], sseBody(turns[ 1 ]));
    assert.equal(bodies[ 2 ], sseBody(turns[ 1 ]));
    assert.deepEqual((await rows(record)).map((row) => row.body.turn), [ 1, 2, 3 ]);
  });
});

test("the example turns reproduce MiniMax-M3's nested exec_command call, then finish", async () => {
  const { turns } = JSON.parse(await readFile(join(SKILL_DIR, "examples", "exec-command.turns.json"), "utf8"));
  assert.equal(turns.length, 2);
  const call = turns[ 0 ].find((event) => event.type === "response.output_item.done" && event.item.type === "function_call").item;
  assert.equal(call.name, "exec_command");
  assert.match(call.id, /^[0-9a-f]{32}_fc_\d+$/);
  assert.deepEqual(JSON.parse(call.arguments), { cmd: "echo autodev-probe" });
  assert.equal(turns[ 1 ].at(-1).type, "response.completed");
  for (const turn of turns) assert.equal(turn.at(-1).type, "response.completed");
});
