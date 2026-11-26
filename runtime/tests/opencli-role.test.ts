import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createOpencliHealthServer, processRunner } from "../src/providers/opencli.ts";
import { OpencliBrowser } from "../src/providers/opencli-browser.ts";
import {
  buildOpencliRoleTaskSpec,
  executeOpencliRoleTurn,
  OPENCLI_ROLE_TURN_PATH,
  OPENCLI_ROUTER_AUTH_VARIABLE,
  runOpencliRoleTurn
} from "../src/providers/opencli-role.ts";
import {
  OpencliCommandError,
  opencliCommandRequiresForeground
} from "../src/providers/opencli-turn.ts";

const task = buildOpencliRoleTaskSpec({  role: "explorer",
  provider: "opencli-chatgpt",
  model: "opencli-chatgpt-balanced",
  sessionId: "opencli-role-regression",
  workspace: process.cwd(),
  mcpApp: "AutoDev explorer",
  systemPrompt: "",
  task: "Reply exactly PONG."
});

test("delegation uses the authenticated browser owner with native role argv and errors", async (t) => {
  const token = "fixture-token";
  const calls: string[][] = [];
  let error: OpencliCommandError | undefined;
  const service = createOpencliHealthServer({
    roleTurnToken: token,
    run: async ({ args }) => {
      calls.push([...args]);
      if (error) throw error;
      return [{ response: "PONG", conversationId: "test-conversation" }];
    }
  });
  const server = createServer((request, response) => {
    void service.handle(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  const vars = {
    [OPENCLI_ROUTER_AUTH_VARIABLE]: token,
    CODEX_OPENCLI_PROXY_HOST: "127.0.0.1",
    CODEX_OPENCLI_PROXY_PORT: String(port)
  };
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const endpoint = `http://127.0.0.1:${port}${OPENCLI_ROLE_TURN_PATH}`;
  const request = {
    role: task.role, provider: task.provider, model: task.model,
    conversationId: null, mcpApp: task.mcpApp, prompt: task.prompt,
    timeoutSeconds: task.timeoutSeconds
  };
  const unauthorized = await fetch(endpoint, { method: "POST", body: "{}" });
  assert.equal(unauthorized.status, 401);
  const invalid = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...request, args: ["arbitrary"] })
  });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 0);

  assert.deepEqual(await runOpencliRoleTurn(task), {
    outputText: "PONG",
    exitCode: 0,
    conversationId: "test-conversation"
  });
  assert.deepEqual(calls[0], [
    "chatgpt", "ask", task.prompt, "--model", "balanced", "--app", task.mcpApp,
    "--new", "true", "--timeout", String(task.timeoutSeconds), "-f", "json"
  ]);
  // The turn selects a model and attaches an app, both of which the ChatGPT
  // adapter can only do natively, so the turn must hold the foreground.
  assert.equal(opencliCommandRequiresForeground(calls[0]!), true);
  error = new OpencliCommandError("App unavailable (Connect the role app)", "APP_NOT_FOUND", 1);
  await assert.rejects(
    runOpencliRoleTurn(task),
    (cause: unknown) =>
      cause instanceof OpencliCommandError &&
      cause.code === "APP_NOT_FOUND" &&
      cause.exitCode === 1 &&
      cause.message === error?.message
  );
  error = new OpencliCommandError("OpenCLI could not start process: ENOENT", "COMMAND_EXEC", null);
  await assert.rejects(
    runOpencliRoleTurn(task),
    (cause: unknown) =>
      cause instanceof OpencliCommandError &&
      cause.exitCode === null &&
      /ENOENT/u.test(cause.message)
  );
});

test("Gemini role turns forward model and thinking level, handle fallbacks, strip prefix, and map quota errors", async () => {
  const calls: string[][] = [];
  const geminiTask = buildOpencliRoleTaskSpec({
    role: "explorer",
    provider: "opencli-gemini",
    model: "opencli-gemini-3.1-pro",
    reasoningEffort: "high",
    sessionId: "gemini-role-test",
    workspace: process.cwd(),
    systemPrompt: "",
    task: "Return OK."
  });
  let mode: "ok" | "thinking-fail" | "limit" | "mismatch" = "ok";
  const result = await executeOpencliRoleTurn(
    geminiTask,
    async ({ args }) => {
      calls.push([...args]);
      if (mode === "thinking-fail" && args.includes("--thinking")) {
        throw new OpencliCommandError(
          "--thinking 'high' is not available",
          "COMMAND_EXEC",
          1
        );
      }
      if (mode === "limit") {
        throw new OpencliCommandError(
          'Gemini model "3.1-pro" is out of usage: Limit resets Nov 9, 9:26 PM',
          "MODEL_LIMIT",
          1
        );
      }
      if (mode === "mismatch") {
        return [{ response: "💬 hi", url: "https://gemini.google.com/app/other-chat" }];
      }
      return [{ response: "💬 OK", url: "https://gemini.google.com/app/gem-123" }];
    },
    AbortSignal.timeout(5000)
  );
  assert.deepEqual(result, {
    outputText: "OK",
    exitCode: 0,
    conversationId: "gem-123"
  });
  assert.ok(calls[0]?.includes("--model"));
  assert.ok(calls[0]?.includes("3.1-pro"));
  assert.ok(calls[0]?.includes("--thinking"));
  assert.ok(calls[0]?.includes("high"));

  mode = "thinking-fail";
  const fallback = await executeOpencliRoleTurn(
    geminiTask,
    async ({ args }) => {
      calls.push([...args]);
      if (args.includes("--thinking")) {
        throw new OpencliCommandError("--thinking 'high' is not available", "COMMAND_EXEC", 1);
      }
      return [{ response: "💬 Fallback OK", url: "https://gemini.google.com/app/gem-123" }];
    },
    AbortSignal.timeout(5000)
  );
  assert.equal(fallback.outputText, "Fallback OK");

  mode = "limit";
  await assert.rejects(
    executeOpencliRoleTurn(
      geminiTask,
      async () => {
        throw new OpencliCommandError(
          'Gemini model "3.1-pro" is out of usage: Limit resets Nov 9, 9:26 PM',
          "MODEL_LIMIT",
          1
        );
      },
      AbortSignal.timeout(5000)
    ),
    (err: unknown) => err instanceof OpencliCommandError && err.code === "MODEL_LIMIT"
  );
});

test("processRunner sanitizes secrets from child env and releases foreground on submitted progress", async () => {
  const previousToken = process.env[OPENCLI_ROUTER_AUTH_VARIABLE];
  const previousCustomSecret = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env[OPENCLI_ROUTER_AUTH_VARIABLE] = "super-secret-opencli-key";
  process.env.AUTODEV_CONTROL_API_TOKEN = "super-secret-control-token";
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const fakeBrowser = {
    run: async (
      _site: "chatgpt" | "gemini",
      _signal: AbortSignal,
      cmd: (endpoint: string, releaseForeground: () => void) => Promise<Record<string, unknown>[]>
    ) => cmd("ws://127.0.0.1:9555/devtools/page/1", () => undefined),
    close: async () => undefined
  } as unknown as OpencliBrowser;
  try {
    const runner = processRunner(
      () => ({ command: "opencli", args: [] }),
      { chatgpt: 1, gemini: 1 },
      new Set(),
      fakeBrowser,
      ((_cmd: string, _args: readonly string[], opts: { env: NodeJS.ProcessEnv }) => {
        seenEnv = opts.env;
        const child = new EventEmitter() as ChildProcess & {
          stdout: PassThrough;
          stderr: PassThrough;
          stdio: [null, PassThrough, PassThrough, PassThrough];
        };
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const progress = new PassThrough();
        child.stdout = stdout;
        child.stderr = stderr;
        (child as unknown as { stdio: unknown[] }).stdio = [null, stdout, stderr, progress];
        queueMicrotask(() => {
          stdout.end(JSON.stringify({ ok: true, data: [{ response: "ok", conversationId: "c1" }] }));
          child.emit("close", 0, null);
        });
        return child as unknown as ChildProcess;
      }) as never
    );
    await runner({
      args: ["chatgpt", "ask", "hi"],
      signal: AbortSignal.timeout(1000)
    });
    assert.equal(seenEnv?.[OPENCLI_ROUTER_AUTH_VARIABLE], undefined);
    assert.equal(seenEnv?.AUTODEV_CONTROL_API_TOKEN, undefined);
    assert.equal(seenEnv?.OPENCLI_CDP_ENDPOINT, "ws://127.0.0.1:9555/devtools/page/1");
  } finally {
    if (previousToken === undefined) delete process.env[OPENCLI_ROUTER_AUTH_VARIABLE];
    else process.env[OPENCLI_ROUTER_AUTH_VARIABLE] = previousToken;
    if (previousCustomSecret === undefined) delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousCustomSecret;
  }
});

test("only the operations that open a menu natively need the browser's foreground", () => {
  // Gemini's adapter never clicks natively, so none of its commands may take
  // the exclusive foreground away from a live ChatGPT turn.
  for (const command of [
    ["gemini", "ask", "hello"],
    ["gemini", "ask", "hello", "--model", "3.1-pro"],
    ["gemini", "ask", "hello", "--thinking", "high"],
    ["gemini", "models"],
    ["gemini", "new"]
  ]) {
    assert.equal(
      opencliCommandRequiresForeground(command),
      false,
      `${command.join(" ")} must not require the foreground`
    );
  }
  // ChatGPT's composer accepts inserted text and its submit button is a
  // scripted click, so a plain turn does not need a visible page either.
  assert.equal(
    opencliCommandRequiresForeground(["chatgpt", "ask", "hello", "--new", "true"]),
    false
  );
  assert.equal(
    opencliCommandRequiresForeground(["chatgpt", "ask-file", "hello", "--file", "p.md"]),
    false
  );
  // Attaching an app and enabling a site tool open the composer's menu with
  // a native click, which a hidden page refuses.
  assert.equal(
    opencliCommandRequiresForeground([
      "chatgpt",
      "ask",
      "hello",
      "--app",
      "AutoDev worker"
    ]),
    true
  );
  assert.equal(
    opencliCommandRequiresForeground([
      "chatgpt",
      "ask",
      "hello",
      "--deep-research",
      "true"
    ]),
    true
  );
  // Selecting a model opens the reasoning slider or the model menu. The
  // settings API covers only some models, and for the rest the visible
  // picker is the only path, so a model switch always needs the foreground.
  assert.equal(
    opencliCommandRequiresForeground([
      "chatgpt",
      "ask",
      "hello",
      "--model",
      "balanced"
    ]),
    true
  );
  assert.equal(
    opencliCommandRequiresForeground([
      "chatgpt",
      "ask",
      "hello",
      "--model",
      "advanced"
    ]),
    true
  );
});
