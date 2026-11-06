import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";

import {
  createOpencliBridge,
  type OpencliRunRequest
} from "@simulatorlife/autodev-runtime/providers/opencli";
import {
  ATTACHED_PROMPT_MESSAGE,
  OPENCLI_SITE_SPECS,
  OpencliCommandError,
  OpencliConversationLedger,
  type OpencliReply,
  opencliToolCallItem,
  parseOpencliOutput,
  parseOpencliReply,
  prefixDigests,
  transcriptSegments
} from "@simulatorlife/autodev-runtime/providers/opencli-turn";
import {
  OPENCLI_MODEL_PATTERN,
  OPENCLI_SITES,
  opencliSiteForModel
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

type JsonRecord = Record<string, unknown>;

const EXEC_TOOL = {
  type: "custom",
  name: "exec",
  description: "Run JavaScript against the `tools` global."
};
const WAIT_TOOL = {
  type: "function",
  name: "wait",
  description: "Wait for a child.",
  parameters: {
    type: "object",
    properties: { ms: { type: "number" } },
    required: ["ms"]
  }
};

function userMessage(text: string): JsonRecord {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }]
  };
}

test("opencli model ids name exactly the served sites", () => {
  assert.equal(opencliSiteForModel("opencli-chatgpt"), "chatgpt");
  assert.equal(opencliSiteForModel("opencli-gemini"), "gemini");
  assert.equal(opencliSiteForModel("opencli-minimax"), null);
  assert.equal(opencliSiteForModel("gpt-6-luna"), null);
  assert.equal(OPENCLI_MODEL_PATTERN.test("opencli-chatgpt-x"), false);
});

test("the shipped routing config routes exactly the served sites", () => {
  const routing = JSON.parse(
    readFileSync(
      resolvePath(import.meta.dirname, "../../config/model-routing.json"),
      "utf8"
    )
  ) as {
    routes: Record<string, { pattern: string; baseUrl: string }>;
    providers: Record<string, { models: Record<string, string> }>;
    providerGroups: Record<string, string[][]>;
  };
  // The config's pattern is the one the router loads, so it must be the
  // shared definition, not a second spelling of it.
  assert.equal(routing.routes.opencli?.pattern, OPENCLI_MODEL_PATTERN.source);
  assert.equal(routing.routes.opencli?.baseUrl, "http://127.0.0.1:4004/v1");
  assert.deepEqual(
    Object.values(routing.providers.opencli?.models ?? {}).sort(),
    OPENCLI_SITES.map((site) => `opencli-${site}`).sort()
  );
  // Opt-in: no tier sends role traffic to a browser tab by default.
  for (const groups of Object.values(routing.providerGroups))
    assert.equal(groups.flat().includes("opencli"), false);
});

test("ChatGPT turns attach the prompt and continue by conversation id", () => {
  const fresh = OPENCLI_SITE_SPECS.chatgpt.args({
    prompt: "ignored",
    promptFile: "/tmp/x/turn.md",
    conversationId: null,
    timeoutSeconds: 300
  });
  assert.deepEqual(fresh, [
    "chatgpt",
    "ask-file",
    ATTACHED_PROMPT_MESSAGE,
    "--file",
    "/tmp/x/turn.md",
    "--new",
    "true",
    "--timeout",
    "300",
    "-f",
    "json"
  ]);
  const continued = OPENCLI_SITE_SPECS.chatgpt.args({
    prompt: "ignored",
    promptFile: "/tmp/x/turn.md",
    conversationId: "abc",
    timeoutSeconds: 300
  });
  assert.deepEqual(continued.slice(5, 7), ["--conversation", "abc"]);
  assert.equal(continued.includes("--new"), false);
});

test("Gemini turns pass the prompt on the command line in a new chat", () => {
  const args = OPENCLI_SITE_SPECS.gemini.args({
    prompt: "the prompt",
    promptFile: "/unused",
    conversationId: null,
    timeoutSeconds: 60
  });
  assert.deepEqual(args, [
    "gemini",
    "ask",
    "the prompt",
    "--new",
    "true",
    "--timeout",
    "60",
    "-f",
    "json"
  ]);
  assert.equal(OPENCLI_SITE_SPECS.gemini.continues, false);
});

test("the opencli JSON envelope yields the reply or a typed failure", () => {
  assert.deepEqual(
    parseOpencliOutput(
      '{"ok":true,"data":[{"conversationId":"c1","conversationUrl":"u","tool":"","response":"Hi"}]}',
      0
    ),
    { response: "Hi", conversationId: "c1" }
  );
  // `ask-file` spells the id in snake_case.
  assert.deepEqual(
    parseOpencliOutput(
      '{"ok":true,"data":[{"conversation_id":"c2","attachments":1,"response":"Yo"}]}',
      0
    ),
    { response: "Yo", conversationId: "c2" }
  );
  assert.throws(
    () =>
      parseOpencliOutput(
        '{"ok":false,"error":{"code":"TIMEOUT","message":"chatgpt ask timed out after 120s","exitCode":75,"hint":"Check read"}}',
        75
      ),
    (error: unknown) =>
      error instanceof OpencliCommandError &&
      error.code === "TIMEOUT" &&
      error.exitCode === 75 &&
      /timed out after 120s \(Check read\)/u.test(error.message)
  );
  assert.throws(
    () => parseOpencliOutput("Segmentation fault", 139),
    /no JSON result \(exit 139\)/u
  );
});

test("a reply splits into prose and tool calls, unwrapping a fenced body", () => {
  const parsed = parseOpencliReply(
    'Checking.\n\n<tool_call name="exec">\nconst a = 1;\n  text(a);\n</tool_call>\n\n<tool_call name="wait">\n```json\n{"ms": 5}\n```\n</tool_call>'
  );
  assert.equal(parsed.text, "Checking.");
  assert.deepEqual(parsed.calls, [
    { name: "exec", input: "const a = 1;\n  text(a);" },
    { name: "wait", input: '{"ms": 5}' }
  ]);
  assert.deepEqual(parseOpencliReply("All done."), {
    text: "All done.",
    calls: []
  });
});

test("parsed calls become the Responses item for the tool Codex offered", () => {
  const tools = [
    {
      kind: "custom" as const,
      name: "exec",
      description: "",
      parameters: null,
      namespace: null
    },
    {
      kind: "function" as const,
      name: "wait",
      description: "",
      parameters: {},
      namespace: null
    }
  ];
  const ids = { itemId: "fc_1", callId: "call_1" };
  assert.deepEqual(
    opencliToolCallItem({ name: "exec", input: "text(1)" }, tools, ids),
    {
      id: "fc_1",
      type: "custom_tool_call",
      status: "completed",
      call_id: "call_1",
      name: "exec",
      input: "text(1)"
    }
  );
  assert.equal(
    opencliToolCallItem({ name: "wait", input: '{"ms":5}' }, tools, ids)
      .arguments,
    '{"ms":5}'
  );
  // An unknown tool or non-JSON arguments reach Codex as written, so Codex's
  // own error output tells the model what it got wrong.
  assert.deepEqual(
    opencliToolCallItem({ name: "read_file", input: "x" }, tools, ids),
    {
      id: "fc_1",
      type: "function_call",
      status: "completed",
      call_id: "call_1",
      name: "read_file",
      arguments: "x"
    }
  );
});

test("the conversation ledger resumes the longest recorded prefix once", () => {
  const ledger = new OpencliConversationLedger();
  const segments = transcriptSegments([
    userMessage("first"),
    { type: "additional_tools", tools: [] },
    { type: "custom_tool_call", name: "exec", call_id: "c", input: "x" }
  ]);
  // The tool surface renders to nothing and is not a segment.
  assert.equal(segments.length, 2);
  const digests = prefixDigests(segments);
  ledger.record("chatgpt", digests[1]!, "conv-1");
  const extended = prefixDigests([...segments, "<tool_output>y</tool_output>"]);
  assert.equal(ledger.take("gemini", extended), null);
  assert.deepEqual(ledger.take("chatgpt", extended), {
    conversationId: "conv-1",
    seen: 2
  });
  // Consumed: a retry of the same request starts a fresh conversation.
  assert.equal(ledger.take("chatgpt", extended), null);
});

interface FakeRun {
  readonly requests: OpencliRunRequest[];
  readonly prompts: string[];
}

async function withBridge(
  replies: Array<OpencliReply | Error>,
  body: (baseUrl: string, runs: FakeRun) => Promise<void>,
  authToken = ""
): Promise<void> {
  const runs: FakeRun = { requests: [], prompts: [] };
  const tempRoot = mkdtempSync(join(tmpdir(), "autodev-opencli-test-"));
  const bridge = createOpencliBridge({
    authToken,
    turnTimeoutSeconds: 30,
    tempRoot,
    run: async (request) => {
      runs.requests.push(request);
      const fileIndex = request.args.indexOf("--file");
      runs.prompts.push(
        fileIndex === -1
          ? String(request.args[2])
          : readFileSync(String(request.args[fileIndex + 1]), "utf8")
      );
      const reply = replies.shift();
      if (!reply) throw new Error("no fake reply left");
      if (reply instanceof Error) throw reply;
      return reply;
    }
  });
  const server: Server = createServer((request, response) => {
    void bridge.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}`, runs);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function post(
  baseUrl: string,
  payload: JsonRecord,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload)
  });
}

test("a tool call goes to Codex and its output continues the same site conversation", async () => {
  await withBridge(
    [
      {
        response:
          'Looking.\n<tool_call name="exec">\ntext(await tools.exec_command({cmd: "pwd"}));\n</tool_call>',
        conversationId: "conv-9"
      },
      { response: "The directory is AutoDev.", conversationId: "conv-9" }
    ],
    async (baseUrl, runs) => {
      const input: JsonRecord[] = [userMessage("Which directory is this?")];
      const first = await post(baseUrl, {
        model: "opencli-chatgpt",
        instructions: "Be brief.",
        tools: [EXEC_TOOL, WAIT_TOOL],
        input
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as { output: JsonRecord[] };
      assert.deepEqual(
        firstBody.output.map((item) => item.type),
        ["message", "custom_tool_call"]
      );
      const call = firstBody.output[1]!;
      assert.equal(call.name, "exec");
      assert.equal(call.input, 'text(await tools.exec_command({cmd: "pwd"}));');
      // The first prompt is the whole turn: rules, instructions, tools, and
      // the conversation, attached as a file in a new chat.
      assert.match(runs.prompts[0]!, /## How to respond/u);
      assert.match(runs.prompts[0]!, /Be brief\./u);
      assert.match(runs.prompts[0]!, /### `exec`/u);
      assert.match(runs.prompts[0]!, /Which directory is this\?/u);
      assert.ok(runs.requests[0]!.args.includes("--new"));

      const second = await post(baseUrl, {
        model: "opencli-chatgpt",
        instructions: "Be brief.",
        tools: [EXEC_TOOL, WAIT_TOOL],
        stream: true,
        input: [
          ...input,
          ...firstBody.output,
          {
            type: "custom_tool_call_output",
            call_id: call.call_id,
            output: "/Users/me/AutoDev\n"
          }
        ]
      });
      assert.equal(second.status, 200);
      assert.match(
        second.headers.get("content-type") ?? "",
        /text\/event-stream/u
      );
      const events = await second.text();
      assert.match(events, /event: response\.completed/u);
      assert.match(events, /"text":"The directory is AutoDev\."/u);
      // The continuation names the conversation and carries only what the
      // site has not seen: the tool output, not the first user message.
      const continued = runs.requests[1]!.args;
      assert.deepEqual(
        continued.slice(
          continued.indexOf("--conversation"),
          continued.indexOf("--conversation") + 2
        ),
        ["--conversation", "conv-9"]
      );
      assert.match(runs.prompts[1]!, /\/Users\/me\/AutoDev/u);
      assert.doesNotMatch(runs.prompts[1]!, /Which directory is this\?/u);
    }
  );
});

test("a site limit is a 429 with limit headers and a timeout is a non-retried 408", async () => {
  await withBridge(
    [
      new OpencliCommandError(
        "You've hit the usage limit reached for today",
        "COMMAND_EXEC",
        1
      ),
      new OpencliCommandError("chatgpt ask timed out after 30s", "TIMEOUT", 75),
      new OpencliCommandError(
        "Could not find Gemini composer",
        "COMMAND_EXEC",
        1
      )
    ],
    async (baseUrl) => {
      const payload = { model: "opencli-chatgpt", input: "hi" };
      const limited = await post(baseUrl, payload);
      assert.equal(limited.status, 429);
      assert.equal(
        limited.headers.get("x-autodev-limit-class"),
        "quota_exhausted"
      );
      const timedOut = await post(baseUrl, payload);
      assert.equal(timedOut.status, 408);
      const broken = await post(baseUrl, {
        model: "opencli-gemini",
        input: "hi"
      });
      assert.equal(broken.status, 503);
      assert.match(
        ((await broken.json()) as { error: { message: string } }).error.message,
        /Gemini composer/u
      );
    }
  );
});

test("the bridge refuses requests it cannot serve before running opencli", async () => {
  await withBridge(
    [],
    async (baseUrl, runs) => {
      const unauthorized = await post(baseUrl, {
        model: "opencli-chatgpt",
        input: "hi"
      });
      assert.equal(unauthorized.status, 401);
      const auth = { authorization: "Bearer secret" };
      const unknown = await post(
        baseUrl,
        { model: "opencli-minimax", input: "hi" },
        auth
      );
      assert.equal(unknown.status, 400);
      const image = await post(
        baseUrl,
        {
          model: "opencli-chatgpt",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: "data:image/png;base64,AAAA"
                }
              ]
            }
          ]
        },
        auth
      );
      assert.equal(image.status, 400);
      assert.equal(
        ((await image.json()) as { error: { type: string } }).error.type,
        "provider_request_unsupported"
      );
      assert.equal(runs.requests.length, 0);
      const models = (await (await fetch(`${baseUrl}/v1/models`)).json()) as {
        data: Array<{ id: string }>;
      };
      assert.deepEqual(
        models.data.map((model) => model.id),
        ["opencli-chatgpt", "opencli-gemini"]
      );
    },
    "secret"
  );
});

test("opencli launcher loads the Router bridge key from the private CODEX_HOME env file", () => {
  const root = mkdtempSync(join(tmpdir(), "autodev-opencli-launcher-"));
  const codexHome = join(root, ".codex");
  const fakeNode = join(root, "fake-node");
  const capture = join(root, "captured");
  const token = "b".repeat(64);
  const launcher = resolvePath(
    import.meta.dirname,
    "../../scripts/run-codex-opencli-proxy.sh"
  );
  try {
    mkdirSync(join(codexHome, "src", "providers"), { recursive: true });
    writeFileSync(join(codexHome, "src", "providers", "opencli.ts"), "//\n");
    writeFileSync(
      join(codexHome, ".env"),
      `CODEX_ROUTER_OPENCLI_API_KEY=${token}\n`,
      { mode: 0o600 }
    );
    writeFileSync(
      fakeNode,
      '#!/bin/sh\nprintf "%s %s %s" "${CODEX_ROUTER_OPENCLI_API_KEY:-}" "$OPENCLI_PROXY_PORT" "$1" > "$OPENCLI_CAPTURE"\n',
      { mode: 0o700 }
    );
    chmodSync(fakeNode, 0o700);
    const result = spawnSync("/bin/bash", [launcher], {
      cwd: root,
      encoding: "utf8",
      env: {
        CODEX_HOME: codexHome,
        HOME: root,
        AUTODEV_NODE_BIN: fakeNode,
        OPENCLI_CAPTURE: capture,
        PATH: "/usr/bin:/bin"
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(capture));
    assert.equal(
      readFileSync(capture, "utf8"),
      `${token} 4004 ${join(codexHome, "src", "providers", "opencli.ts")}`
    );
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
