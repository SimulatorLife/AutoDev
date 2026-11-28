import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CODEX_HOST_ARGUMENT } from "../src/hooks/hook-payload.ts";
import { reportSkillRead } from "../src/hooks/skill-read-telemetry.ts";
import {
  ensureLocalAdmission,
  readLocalAdmission
} from "../src/mcp/gateway-admission.ts";
import { handleRequest } from "../src/router/http.ts";
import {
  getDefaultUsageTracker,
  safePrivacyWorkspace
} from "../src/router/usage.ts";
import { SKILL_READ_EVENTS_PATH } from "../src/shared/skill-read-observation.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SKILL_PATH = path.relative(
  REPO_ROOT,
  path.join(REPO_ROOT, ".rulesync", "skills", "orchestration", "SKILL.md")
);

/**
A PreToolUse read of the orchestration skill, as a host sends it.
*/
function readPayload(callId?: string): string {
  return JSON.stringify({
    session_id: "codex-session-1",
    turn_id: "turn-1",
    cwd: REPO_ROOT,
    model: "gpt-6-luna",
    tool_name: "read_file",
    tool_input: { path: SKILL_PATH },
    ...(callId !== undefined && { tool_use_id: callId })
  });
}

test("the hook reports an AutoDev session's read with its own attribution, once per turn", async (t) => {
  const codexHome = mkdtempSync(path.join(tmpdir(), "skill-read-hook-"));
  try {
    ensureLocalAdmission(codexHome);
    const posts: Array<{ url: string; auth: string; body: unknown }> = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (url: unknown, options: RequestInit) => {
        posts.push({
          url: String(url),
          auth: String(new Headers(options.headers).get("authorization")),
          body: JSON.parse(String(options.body))
        });
        return new Response("{}", { status: 200 });
      }
    );
    const environment = { CODEX_HOME: codexHome, HOME: codexHome };
    const codex = [CODEX_HOST_ARGUMENT];
    await reportSkillRead(readPayload("call-1"), environment, codex);
    await reportSkillRead(readPayload("call-2"), environment, codex);
    // An unrelated native chat sharing the hooks is not AutoDev's evidence.
    await reportSkillRead(readPayload("call-3"), environment, []);

    assert.equal(posts.length, 2);
    assert.equal(
      posts[0]?.url,
      `http://127.0.0.1:4100${SKILL_READ_EVENTS_PATH}`
    );
    assert.equal(
      posts[0]?.auth,
      `Bearer ${readLocalAdmission(codexHome)!.key}`
    );
    assert.deepEqual(posts[0]?.body, {
      sessionId: "codex-session-1",
      eventId: (posts[0]?.body as { eventId: string }).eventId,
      skill: "orchestration",
      role: "orchestrator",
      provider: null,
      model: "gpt-6-luna",
      workspace: path.basename(REPO_ROOT)
    });
    // One turn's repeated read carries one identity.
    assert.deepEqual(posts[1]?.body, posts[0]?.body);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("the Runtime records an authenticated read once and refuses an unauthenticated one", async () => {
  const codexHome = process.env.CODEX_HOME!;
  ensureLocalAdmission(codexHome);
  const key = readLocalAdmission(codexHome)!.key;
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const post = (authorization: string | null, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${SKILL_READ_EVENTS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization !== null && { authorization })
      },
      body: JSON.stringify(body)
    });
  const observation = {
    sessionId: "codex-session-route",
    eventId: `read:${"a".repeat(64)}`,
    skill: "orchestration",
    role: "orchestrator",
    provider: null,
    model: "gpt-6-luna",
    workspace: "AutoDev"
  };
  try {
    // The read is counted under its workspace's skill uses.
    const skillUsed = () => {
      const bucket =
        getDefaultUsageTracker().usageTelemetry.byWorkspace[
          safePrivacyWorkspace("AutoDev")
        ];
      return [
        bucket?.skillUses ?? 0,
        bucket?.skills?.get("orchestration")?.uses ?? 0
      ];
    };
    const [beforeUses = 0, beforeSkill = 0] = skillUsed();

    assert.equal((await post(null, observation)).status, 401);
    assert.equal((await post("Bearer wrong", observation)).status, 401);
    assert.equal(
      (await post(`Bearer ${key}`, { ...observation, extra: 1 })).status,
      400
    );
    assert.deepEqual(skillUsed(), [beforeUses, beforeSkill]);

    const first = await post(`Bearer ${key}`, observation);
    assert.deepEqual(await first.json(), { accepted: true });
    const retry = await post(`Bearer ${key}`, observation);
    assert.deepEqual(await retry.json(), { accepted: false });
    assert.deepEqual(skillUsed(), [beforeUses + 1, beforeSkill + 1]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
