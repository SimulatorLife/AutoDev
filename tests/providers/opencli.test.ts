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
  type OpencliRunRequest,
  opencliSiteSlots,
  opencliTurnLogLine,
  routedSiteTabs
} from "@simulatorlife/autodev-runtime/providers/opencli";
import {
  attachedPromptFileName,
  attachedPromptMessage,
  CHATGPT_MODELS,
  compactCodeModeDescription,
  compactTranscript,
  describeTranscriptBytes,
  geminiConversationId,
  OPENCLI_SITE_SPECS,
  OpencliCommandError,
  OpencliConversationLedger,
  opencliToolCallItem,
  parseOpencliOutput,
  parseOpencliReply,
  prefixDigests,
  replyFromRow,
  toolIndex,
  transcriptEntries,
  transcriptSegments
} from "@simulatorlife/autodev-runtime/providers/opencli-turn";
import { ROUTES } from "@simulatorlife/autodev-runtime/router/routing";
import { resolveOpencliCommand } from "@simulatorlife/autodev-runtime/shared/executables";
import {
  OPENCLI_CHATGPT_MODEL_PATTERN,
  OPENCLI_GEMINI_MODEL_PATTERN,
  OPENCLI_PROVIDERS,
  opencliModel
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

type JsonRecord = Record<string, unknown>;

/** One tab per site: these tests drive a site's turns one at a time. */
const ONE_TAB_PER_SITE = { chatgpt: 1, gemini: 1 } as const;

test("each site gets as many tabs as its route takes concurrent requests", () => {
  assert.deepEqual(routedSiteTabs(ROUTES), { chatgpt: 3, gemini: 1 });
  assert.deepEqual(
    routedSiteTabs([
      { provider: "opencli-chatgpt", maxConcurrentRequests: 5 },
      { provider: "opencli-gemini" }
    ]),
    { chatgpt: 5, gemini: 1 }
  );
  // opencli pools every site's commands into that many tabs.
  assert.equal(
    opencliSiteSlots({ chatgpt: 3, gemini: 1 }),
    "chatgpt:3,gemini:1"
  );
});

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

test("opencli model ids name a provider and the site's own model", () => {
  assert.deepEqual(opencliModel("opencli-chatgpt-advanced"), {
    provider: "opencli-chatgpt",
    site: "chatgpt",
    siteModel: "advanced"
  });
  assert.deepEqual(opencliModel("opencli-gemini-3.1-pro"), {
    provider: "opencli-gemini",
    site: "gemini",
    siteModel: "3.1-pro"
  });
  assert.equal(opencliModel("opencli-chatgpt"), null);
  assert.equal(opencliModel("opencli-minimax-m3"), null);
  assert.equal(opencliModel("gemini-3.8-flash"), null);
  assert.equal(
    OPENCLI_GEMINI_MODEL_PATTERN.test("opencli-gemini-3.8-flash"),
    true
  );
  assert.equal(
    OPENCLI_CHATGPT_MODEL_PATTERN.test("opencli-gemini-3.8-flash"),
    false
  );
});

test("the shipped routing config gives each opencli provider its own route and catalog models", () => {
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
  const patterns = {
    "opencli-chatgpt": OPENCLI_CHATGPT_MODEL_PATTERN,
    "opencli-gemini": OPENCLI_GEMINI_MODEL_PATTERN
  } as const;
  const catalogSlugs = (provider: string): string[] =>
    (
      JSON.parse(
        readFileSync(
          resolvePath(
            import.meta.dirname,
            `../../config/catalogs/${provider}-model-catalog.json`
          ),
          "utf8"
        )
      ) as { models: Array<{ slug: string }> }
    ).models.map((model) => model.slug);
  for (const provider of OPENCLI_PROVIDERS) {
    // The config's pattern is the one the router loads, so it must be the
    // shared definition, not a second spelling of it.
    assert.equal(routing.routes[provider]?.pattern, patterns[provider].source);
    // One bridge serves both.
    assert.equal(routing.routes[provider]?.baseUrl, "http://127.0.0.1:4004/v1");
    const slugs = new Set(catalogSlugs(provider));
    for (const model of Object.values(
      routing.providers[provider]?.models ?? {}
    ))
      assert.ok(slugs.has(model), `${model} has a ${provider} catalog entry`);
    // Opt-in: no tier sends role traffic to a browser tab by default.
    for (const groups of Object.values(routing.providerGroups))
      assert.equal(groups.flat().includes(provider), false);
  }
  // Every ChatGPT level opencli can switch to is a catalog model.
  assert.deepEqual(
    CHATGPT_MODELS.map((level) => `opencli-chatgpt-${level}`),
    catalogSlugs("opencli-chatgpt")
  );
});

function recordingExec(rows: JsonRecord[]): {
  exec: (args: readonly string[]) => Promise<JsonRecord[]>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (args) => {
      calls.push([...args]);
      const row = rows.shift();
      if (!row) throw new Error("no fake row left");
      return [row];
    }
  };
}

test("ChatGPT turns attach the prompt and continue by conversation id", async () => {
  const fresh = recordingExec([{ response: "Hi", conversation_id: "c1" }]);
  assert.deepEqual(
    await OPENCLI_SITE_SPECS.chatgpt.turn(
      {
        prompt: "ignored",
        promptFile: "/tmp/x/turn.md",
        typed: false,
        conversationId: null,
        siteModel: "advanced",
        siteThinking: null,
        selectModel: false,
        timeoutSeconds: 300
      },
      fresh.exec
    ),
    { response: "Hi", conversationId: "c1", modelSelected: true }
  );
  assert.deepEqual(fresh.calls, [
    [
      "chatgpt",
      "ask-file",
      attachedPromptMessage("turn.md"),
      "--file",
      "/tmp/x/turn.md",
      "--new",
      "true",
      "--timeout",
      "300",
      "-f",
      "json"
    ]
  ]);
  const continued = recordingExec([
    { response: "Again", conversation_id: "abc" }
  ]);
  await OPENCLI_SITE_SPECS.chatgpt.turn(
    {
      prompt: "ignored",
      promptFile: "/tmp/x/turn.md",
      typed: false,
      conversationId: "abc",
      siteModel: "advanced",
      siteThinking: null,
      selectModel: false,
      timeoutSeconds: 300
    },
    continued.exec
  );
  assert.deepEqual(continued.calls[0]!.slice(5, 7), ["--conversation", "abc"]);
  assert.equal(continued.calls[0]!.includes("--new"), false);
  // ChatGPT's model is an account setting: switched first when it changes.
  const switched = recordingExec([
    { Status: "ok", Model: "Very High" },
    { response: "Hi", conversation_id: "c1" }
  ]);
  await OPENCLI_SITE_SPECS.chatgpt.turn(
    {
      prompt: "ignored",
      promptFile: "/tmp/x/turn.md",
      typed: false,
      conversationId: null,
      siteModel: "xhigh",
      siteThinking: null,
      selectModel: true,
      timeoutSeconds: 300
    },
    switched.exec
  );
  assert.deepEqual(switched.calls[0], [
    "chatgpt",
    "model",
    "xhigh",
    "-f",
    "json"
  ]);
});

test("Gemini is asked with its current model when its model picker cannot be read", async () => {
  const calls: string[][] = [];
  let asks = 0;
  const exec = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[1] === "ask") {
      asks += 1;
      if (asks === 1)
        throw new OpencliCommandError(
          "Gemini model discovery returned no selectable models. Gemini Web may have changed its model selector UI.",
          "COMMAND_EXEC",
          1
        );
      return [
        { response: "💬 answered", url: "https://gemini.google.com/app/abc" }
      ];
    }
    return [{ Url: "https://gemini.google.com/app/abc" }];
  };
  const reply = await OPENCLI_SITE_SPECS.gemini.turn(
    {
      prompt: "p",
      promptFile: "/unused",
      typed: false,
      conversationId: null,
      siteModel: "3.1-pro",
      siteThinking: null,
      selectModel: true,
      timeoutSeconds: 60
    },
    exec
  );
  assert.equal(reply.response, "answered");
  const askCalls = calls.filter((args) => args[1] === "ask");
  assert.equal(askCalls.length, 2);
  assert.ok(askCalls[0]!.includes("--model"));
  assert.equal(askCalls[1]!.includes("--model"), false);
});

test("a Gemini turn asks for the thinking level the operator chose", async () => {
  const calls: string[][] = [];
  const exec = async (args: readonly string[]) => {
    calls.push([...args]);
    return [
      { response: "💬 answered", url: "https://gemini.google.com/app/abc" }
    ];
  };
  const reply = await OPENCLI_SITE_SPECS.gemini.turn(
    {
      prompt: "p",
      promptFile: "/unused",
      typed: false,
      conversationId: null,
      siteModel: "3.1-pro",
      siteThinking: "high",
      selectModel: true,
      timeoutSeconds: 60
    },
    exec
  );
  const ask = calls.find((args) => args[1] === "ask");
  assert.ok(ask);
  assert.equal(ask[ask.indexOf("--thinking") + 1], "high");
  // The site took the level, so the reply says so.
  assert.equal(reply.thinking, "high");
});

test("a Gemini turn whose thinking level could not be selected runs at the level the site has", async () => {
  // The thinking level is a preference of the site's own account, like the
  // model: a site that cannot take it answers at the level it has instead of
  // failing the turn.
  const calls: string[][] = [];
  const exec = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[1] === "ask" && args.includes("--thinking"))
      throw new OpencliCommandError(
        "Could not select thinking level 'high' in the Gemini web UI",
        "ARGUMENT",
        2
      );
    return [
      { response: "💬 answered", url: "https://gemini.google.com/app/abc" }
    ];
  };
  const reply = await OPENCLI_SITE_SPECS.gemini.turn(
    {
      prompt: "p",
      promptFile: "/unused",
      typed: false,
      conversationId: null,
      siteModel: "3.1-pro",
      siteThinking: "high",
      selectModel: true,
      timeoutSeconds: 60
    },
    exec
  );
  assert.equal(reply.response, "answered");
  const asks = calls.filter((args) => args[1] === "ask");
  assert.equal(asks.length, 2);
  assert.equal(asks[0]!.includes("--thinking"), true);
  assert.equal(asks[1]!.includes("--thinking"), false);
  // The model the turn asked for is kept: only the level was declined.
  assert.equal(asks[1]!.includes("--model"), true);
  // The site answered at the level it had, not at the one that was asked for.
  assert.equal(reply.thinking, null);
});

test("a Gemini turn whose level the site refused asks for the level again", async () => {
  // The level the site refused is not the level the site is at. A bridge that
  // remembered the refused level as applied would never ask for it again, and
  // the site would answer every later turn at the level it had.
  await withBridge(
    [
      new OpencliCommandError(
        "Could not select thinking level 'high' in the Gemini web UI",
        "ARGUMENT",
        2
      ),
      { response: "💬 answered", url: "https://gemini.google.com/app/one" },
      { response: "💬 answered", url: "https://gemini.google.com/app/two" }
    ],
    async (baseUrl, runs) => {
      const first = await post(baseUrl, {
        model: "opencli-gemini-3.1-pro",
        reasoning: { effort: "high" },
        input: [userMessage("first")]
      });
      assert.equal(first.status, 200);
      const second = await post(baseUrl, {
        model: "opencli-gemini-3.1-pro",
        reasoning: { effort: "high" },
        input: [userMessage("second")]
      });
      assert.equal(second.status, 200);
      const asks = runs.requests.filter((request) => request.args[1] === "ask");
      // The first turn asked for the level, the site refused it, and the
      // retry that answered the turn did not ask again...
      assert.equal(asks[0]!.args.includes("--thinking"), true);
      assert.equal(asks[1]!.args.includes("--thinking"), false);
      // ...so the next turn asks for the level once more.
      assert.equal(asks[2]!.args.includes("--thinking"), true);
      assert.equal(
        asks[2]!.args[asks[2]!.args.indexOf("--thinking") + 1],
        "high"
      );
    }
  );
});

test("a Gemini turn at the level the site already has does not ask for it again", async () => {
  // Asking for the level opens a menu on the site and closes it again: a
  // bridge that asks every turn pays that on every turn.
  await withBridge(
    [
      { response: "💬 answered", url: "https://gemini.google.com/app/one" },
      { response: "💬 answered", url: "https://gemini.google.com/app/two" }
    ],
    async (baseUrl, runs) => {
      const first = await post(baseUrl, {
        model: "opencli-gemini-3.1-pro",
        reasoning: { effort: "high" },
        input: [userMessage("first")]
      });
      assert.equal(first.status, 200);
      const second = await post(baseUrl, {
        model: "opencli-gemini-3.1-pro",
        reasoning: { effort: "high" },
        input: [userMessage("second")]
      });
      assert.equal(second.status, 200);
      const asks = runs.requests.filter((request) => request.args[1] === "ask");
      assert.equal(asks[0]!.args.includes("--thinking"), true);
      assert.equal(asks[1]!.args.includes("--thinking"), false);
    }
  );
});

test("every turn attaches its prompt under a fresh name the message names", () => {
  // ChatGPT renames a repeated upload, which opencli then cannot match.
  const first = attachedPromptFileName();
  assert.match(first, /^turn-[0-9a-f]{12}\.md$/u);
  assert.notEqual(first, attachedPromptFileName());
  assert.equal(
    attachedPromptMessage(first),
    `Read the attached file ${first} and respond exactly as it instructs.`
  );
});

test("Gemini turns take the chat from the page that answered and reopen it to continue", async () => {
  // `ask` names the chat by the URL of the page it answered on. A separate
  // `status` can bind another Gemini tab, so none is run after the answer.
  const fresh = recordingExec([
    {
      response: "💬 PONG",
      url: "https://gemini.google.com/app/0c7fc86c8c985ae2"
    }
  ]);
  assert.deepEqual(
    await OPENCLI_SITE_SPECS.gemini.turn(
      {
        prompt: "the prompt",
        promptFile: "/unused",
        typed: false,
        conversationId: null,
        siteModel: "3.1-pro",
        siteThinking: null,
        selectModel: true,
        timeoutSeconds: 60
      },
      fresh.exec
    ),
    // The adapter's speech-bubble decoration is not the model's. The turn
    // asked for no level, so the reply establishes none.
    {
      response: "PONG",
      conversationId: "0c7fc86c8c985ae2",
      thinking: null,
      modelSelected: true
    }
  );
  assert.deepEqual(fresh.calls, [
    [
      "gemini",
      "ask",
      "the prompt",
      "--model",
      "3.1-pro",
      "--new",
      "true",
      "--timeout",
      "60",
      "-f",
      "json"
    ]
  ]);
  // One command continues the chat: opencli opens it and confirms it on the
  // sending page right before sending, so no other command can move the tab
  // in between. The site is already on the model, so the picker is left
  // alone: opening it every turn cost seconds and failed turns whenever the
  // window could not render it.
  const continued = recordingExec([
    { response: "next", url: "https://gemini.google.com/app/0c7fc86c8c985ae2" }
  ]);
  await OPENCLI_SITE_SPECS.gemini.turn(
    {
      prompt: "only the delta",
      promptFile: "/unused",
      typed: false,
      conversationId: "0c7fc86c8c985ae2",
      siteModel: "3.1-pro",
      siteThinking: null,
      selectModel: false,
      timeoutSeconds: 60
    },
    continued.exec
  );
  assert.deepEqual(continued.calls, [
    [
      "gemini",
      "ask",
      "only the delta",
      "--conversation",
      "0c7fc86c8c985ae2",
      "--timeout",
      "60",
      "-f",
      "json"
    ]
  ]);
  assert.equal(geminiConversationId("https://gemini.google.com/app"), null);
});

test("the opencli JSON envelope yields the reply or a typed failure", () => {
  assert.deepEqual(
    replyFromRow(
      parseOpencliOutput(
        '{"ok":true,"data":[{"conversationId":"c1","conversationUrl":"u","tool":"","response":"Hi"}]}',
        0
      )[0]!
    ),
    { response: "Hi", conversationId: "c1" }
  );
  // `ask-file` spells the id in snake_case.
  assert.deepEqual(
    replyFromRow(
      parseOpencliOutput(
        '{"ok":true,"data":[{"conversation_id":"c2","attachments":1,"response":"Yo"}]}',
        0
      )[0]!
    ),
    { response: "Yo", conversationId: "c2" }
  );
  assert.throws(() => replyFromRow({ attachments: 1 }), /empty reply/u);
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
    calls: [],
    unparsedCall: false
  });
});

test("a call is read whatever its quoting, namespace, escaping or missing close", () => {
  // Single quotes and a namespaced name are still a call.
  assert.deepEqual(
    parseOpencliReply("<tool_call name='mcp__lsp__hover'>{}</tool_call>").calls,
    [{ name: "mcp__lsp__hover", input: "{}" }]
  );
  // A site that renders the reply as HTML escapes the call and its body.
  const escaped = parseOpencliReply(
    'Next.\n&lt;tool_call name=&quot;exec&quot;&gt;a &amp;&amp; b&lt;/tool_call&gt;'
  );
  assert.deepEqual(escaped.calls, [{ name: "exec", input: "a && b" }]);
  assert.equal(escaped.text, "Next.");
  // A reply that ends inside its last call still makes that call.
  const cut = parseOpencliReply('Run it.\n<tool_call name="exec">\ntext(1);');
  assert.deepEqual(cut.calls, [{ name: "exec", input: "text(1);" }]);
  assert.equal(cut.unparsedCall, false);
  // A call the parser cannot read is reported, not passed off as prose.
  const garbled = parseOpencliReply("<tool_call exec>text(1);</tool_call>");
  assert.deepEqual(garbled.calls, []);
  assert.equal(garbled.unparsedCall, true);
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

test("transcript entries name each rendered item's kind and the turn log totals bytes per kind", () => {
  const entries = transcriptEntries([
    userMessage("first"),
    { type: "message", role: "developer", content: "policy" },
    { type: "reasoning", summary: [] },
    { type: "additional_tools", tools: [] },
    { type: "custom_tool_call", name: "exec", call_id: "c", input: "x" },
    { type: "custom_tool_call_output", call_id: "c", output: "a".repeat(40) },
    { type: "function_call_output", call_id: "d", output: "b".repeat(20) }
  ]);
  // Reasoning and the tool surface render to nothing and are not entries.
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["user", "developer", "tool_call", "tool_output", "tool_output"]
  );
  const outputBytes =
    Buffer.byteLength(entries[3]!.text) + Buffer.byteLength(entries[4]!.text);
  const described = describeTranscriptBytes(entries);
  assert.match(described, new RegExp(`^tool_output ${outputBytes} B in 2, `));
  assert.match(described, /developer \d+ B in 1/);
  assert.equal(describeTranscriptBytes([]), "none");
});

test("the turn log line counts only the new items of a continued chat, and every item of a new one, with where its time went", () => {
  const entries = transcriptEntries([
    userMessage("first"),
    { type: "custom_tool_call", name: "exec", call_id: "c", input: "x" },
    { type: "custom_tool_call_output", call_id: "c", output: "result" }
  ]);
  const turn = {
    site: "chatgpt",
    siteModel: "gpt-5",
    tools: [{}, {}],
    entries,
    seen: 2
  };
  const outputBytes = Buffer.byteLength(entries[2]!.text);
  const continued = opencliTurnLogLine(
    turn,
    {
      prompt: "abcd",
      continued: true,
      timing: { queuedMs: 4200, onSiteMs: 113_900 }
    },
    1
  );
  assert.equal(
    continued,
    `opencli chatgpt/gpt-5 turn: 1 tool call(s), 2 tool(s) offered, 4-byte prompt, queued 4.2s, on site 113.9s, continued conversation; new items: tool_output ${outputBytes} B in 1`
  );
  // A chat that could not be continued sent the whole conversation instead.
  const restarted = opencliTurnLogLine(
    turn,
    {
      prompt: "abcdefgh",
      continued: false,
      timing: { queuedMs: 0, onSiteMs: 61_000 }
    },
    0
  );
  assert.match(
    restarted,
    /^opencli chatgpt\/gpt-5 turn: 0 tool call\(s\), 2 tool\(s\) offered, 8-byte prompt, queued 0\.0s, on site 61\.0s; conversation items: /
  );
  assert.match(restarted, /tool_output \d+ B in 1/);
  assert.match(restarted, /tool_call \d+ B in 1/);
  assert.match(restarted, /user \d+ B in 1/);
});

test("the conversation ledger resumes the longest recorded prefix until the turn succeeds", () => {
  const ledger = new OpencliConversationLedger();
  const CHATGPT_SCOPE = { site: "chatgpt", thread: "thread-a" } as const;
  const segments = transcriptSegments([
    userMessage("first"),
    { type: "additional_tools", tools: [] },
    { type: "custom_tool_call", name: "exec", call_id: "c", input: "x" }
  ]);
  // The tool surface renders to nothing and is not a segment.
  assert.equal(segments.length, 2);
  const digests = prefixDigests(segments);
  ledger.record(CHATGPT_SCOPE, digests[1]!, "conv-1");
  const extended = prefixDigests([...segments, "<tool_output>y</tool_output>"]);
  assert.equal(
    ledger.find({ site: "gemini", thread: "thread-a" }, extended),
    null
  );
  const resume = ledger.find(CHATGPT_SCOPE, extended);
  assert.deepEqual(resume, {
    conversationId: "conv-1",
    seen: 2,
    digest: digests[1]
  });
  // Another agent's thread never resolves to this thread's chat, however
  // alike their transcripts.
  assert.equal(
    ledger.find({ site: "chatgpt", thread: "thread-b" }, extended),
    null
  );
  // A retry of a turn that failed continues the same conversation...
  assert.deepEqual(ledger.find(CHATGPT_SCOPE, extended), resume);
  // ...and the entry is spent only once a turn continuing from it succeeds.
  ledger.consume(CHATGPT_SCOPE, resume!.digest);
  assert.equal(ledger.find(CHATGPT_SCOPE, extended), null);
});

test("a streamed turn opens at once, keeps alive, and reports a failure in the stream", async () => {
  let release: (row: JsonRecord | Error) => void = () => {};
  const bridge = createOpencliBridge({
    siteTabs: ONE_TAB_PER_SITE,
    authToken: "",
    turnTimeoutSeconds: 30,
    sessionBusyRetryMs: 1,
    run: async (request) => {
      if (request.args[1] === "model")
        return [{ Status: "ok", Model: String(request.args[2]) }];
      const row = await new Promise<JsonRecord | Error>((resolve) => {
        release = resolve;
      });
      if (row instanceof Error) throw row;
      return [row];
    }
  });
  const server: Server = createServer((request, response) => {
    void bridge.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await post(`http://127.0.0.1:${port}`, {
      model: "opencli-chatgpt-balanced",
      stream: true,
      input: "hi"
    });
    // Headers arrive before the site has answered: no client headers timeout.
    assert.equal(response.status, 200);
    release(
      new OpencliCommandError(
        "ChatGPT reply could not be read",
        "COMMAND_EXEC",
        1
      )
    );
    const events = await response.text();
    assert.match(events, /event: response\.created/u);
    assert.match(events, /event: response\.failed/u);
    assert.match(events, /ChatGPT reply could not be read/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the conversation ledger survives a bridge restart through its file", () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-opencli-ledger-"));
  const file = join(directory, "run", "opencli-conversations.json");
  try {
    const digests = prefixDigests([
      "<user>\nhi\n</user>",
      "<assistant>\nyo\n</assistant>"
    ]);
    const SCOPE = { site: "chatgpt", thread: "thread-a" } as const;
    const first = new OpencliConversationLedger({ file });
    first.record(SCOPE, digests[1]!, "conv-1");
    // A restart is a new ledger reading the same file.
    const restarted = new OpencliConversationLedger({ file });
    assert.deepEqual(restarted.find(SCOPE, digests), {
      conversationId: "conv-1",
      seen: 2,
      digest: digests[1]
    });
    restarted.consume(SCOPE, digests[1]!);
    assert.equal(new OpencliConversationLedger({ file }).size, 0);
    // An unreadable file is an empty ledger, not a bridge that cannot start.
    writeFileSync(file, "{not json");
    assert.equal(new OpencliConversationLedger({ file }).size, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a later message in the same session continues the same chat after a restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-opencli-restart-"));
  const file = join(directory, "opencli-conversations.json");
  const serve = async (
    reply: JsonRecord,
    payload: JsonRecord
  ): Promise<{ args: readonly string[]; body: { output: JsonRecord[] } }> => {
    let args: readonly string[] = [];
    const bridge = createOpencliBridge({
      siteTabs: ONE_TAB_PER_SITE,
      authToken: "",
      turnTimeoutSeconds: 30,
      ledger: new OpencliConversationLedger({ file }),
      run: async (request) => {
        if (request.args[1] === "model")
          return [{ Status: "ok", Model: String(request.args[2]) }];
        args = request.args;
        return [reply];
      }
    });
    const server: Server = createServer((request, response) => {
      void bridge.handle(request, response);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = server.address() as AddressInfo;
    try {
      const response = await post(`http://127.0.0.1:${port}`, payload);
      return {
        args,
        body: (await response.json()) as { output: JsonRecord[] }
      };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  try {
    const input: JsonRecord[] = [userMessage("Make the safety car bigger.")];
    const first = await serve(
      { response: "Done.", conversation_id: "conv-7" },
      { model: "opencli-chatgpt-balanced", input }
    );
    assert.ok(first.args.includes("--new"));
    // A web chat reports no tokens, so the response carries no usage rather
    // than a fabricated zero, and it says where the turn's time went.
    assert.equal(Object.hasOwn(first.body, "usage"), false);
    const phases = (first.body as unknown as JsonRecord).autodev_phases as
      { queued_ms: unknown; on_site_ms: unknown } | undefined;
    assert.ok(Number.isInteger(phases?.queued_ms));
    assert.ok(Number.isInteger(phases?.on_site_ms));
    // The bridge restarts (a deploy); the user then says "Continue".
    const later = await serve(
      { response: "Continuing.", conversation_id: "conv-7" },
      {
        model: "opencli-chatgpt-balanced",
        input: [...input, ...first.body.output, userMessage("Continue")]
      }
    );
    assert.deepEqual(
      later.args.slice(
        later.args.indexOf("--conversation"),
        later.args.indexOf("--conversation") + 2
      ),
      ["--conversation", "conv-7"]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a recorded chat that no longer opens is replaced by a new chat, not retried forever", async () => {
  const notReady = () =>
    new OpencliCommandError(
      "ChatGPT ask-file requires an authenticated session with an active composer.",
      "COMMAND_EXEC",
      1
    );
  await withBridge(
    [
      { response: "Done.", conversation_id: "conv-gone" },
      // Continuing conv-gone fails before sending, retries included.
      notReady(),
      notReady(),
      notReady(),
      { response: "Continuing in a new chat.", conversation_id: "conv-new" }
    ],
    async (baseUrl, runs) => {
      const input: JsonRecord[] = [userMessage("Start.")];
      const first = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        input
      });
      const firstBody = (await first.json()) as { output: JsonRecord[] };
      const later = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        input: [...input, ...firstBody.output, userMessage("Continue")]
      });
      assert.equal(later.status, 200);
      const last = runs.requests.at(-1)!.args;
      assert.ok(last.includes("--new"));
      assert.equal(last.includes("--conversation"), false);
      // The new chat gets the whole conversation, the first message included.
      assert.match(runs.prompts.at(-1)!, /Start\./u);
      assert.match(runs.prompts.at(-1)!, /## How to respond/u);
    }
  );
});

test("concurrent agents with identical transcripts each keep their own chat", async () => {
  let nextChat = 0;
  const continuedIn: string[] = [];
  const bridge = createOpencliBridge({
    siteTabs: ONE_TAB_PER_SITE,
    authToken: "",
    turnTimeoutSeconds: 30,
    run: async (request) => {
      if (request.args[1] === "model")
        return [{ Status: "ok", Model: String(request.args[2]) }];
      const at = request.args.indexOf("--conversation");
      const chat =
        at === -1 ? `chat-${++nextChat}` : String(request.args[at + 1]);
      if (at !== -1) continuedIn.push(chat);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [{ response: `answered in ${chat}`, conversation_id: chat }];
    }
  });
  const server: Server = createServer((request, response) => {
    void bridge.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const forThread = (thread: string) => ({
    "x-codex-turn-metadata": JSON.stringify({ thread_id: thread })
  });
  try {
    // Two subagents spawned with the same task: identical first requests.
    const input: JsonRecord[] = [userMessage("Review the renderer.")];
    const firsts = await Promise.all(
      ["thread-a", "thread-b"].map(async (thread) => {
        const response = await post(
          baseUrl,
          { model: "opencli-chatgpt-balanced", input },
          forThread(thread)
        );
        return {
          thread,
          body: (await response.json()) as {
            output: JsonRecord[];
            output_text: string;
          }
        };
      })
    );
    const chatOf = new Map(
      firsts.map(({ thread, body }) => [
        thread,
        body.output_text.replace("answered in ", "")
      ])
    );
    assert.notEqual(chatOf.get("thread-a"), chatOf.get("thread-b"));
    // Their follow-ups, again at once, each continue the agent's own chat.
    const follow = await Promise.all(
      firsts.map(async ({ thread, body }) => {
        const response = await post(
          baseUrl,
          {
            model: "opencli-chatgpt-balanced",
            input: [...input, ...body.output, userMessage("Continue")]
          },
          forThread(thread)
        );
        const reply = (await response.json()) as { output_text: string };
        return [thread, reply.output_text.replace("answered in ", "")];
      })
    );
    for (const [thread, chat] of follow)
      assert.equal(chat, chatOf.get(thread!), `${thread} stayed in its chat`);
    assert.equal(continuedIn.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a Gemini answer from another chat fails the turn", async () => {
  // The check before sending is opencli's, on the page that sends; this is
  // the bridge's own check of where the answer came from.
  const calls: string[][] = [];
  await assert.rejects(
    OPENCLI_SITE_SPECS.gemini.turn(
      {
        prompt: "delta",
        promptFile: "/unused",
        typed: false,
        conversationId: "mine",
        siteModel: "3.1-pro",
        siteThinking: null,
        selectModel: false,
        timeoutSeconds: 60
      },
      async (args) => {
        calls.push([...args]);
        return [
          { response: "answer", url: "https://gemini.google.com/app/theirs" }
        ];
      }
    ),
    (error: unknown) =>
      error instanceof OpencliCommandError &&
      error.code === "CHAT_MISMATCH" &&
      /answered in chat theirs, not mine/u.test(error.message)
  );
  assert.equal(calls.length, 1);
});

test("a ChatGPT answer from another chat fails the turn and is not recorded", async () => {
  await withBridge(
    [
      { response: "Done.", conversation_id: "conv-a" },
      { response: "Wrong place.", conversation_id: "conv-b" }
    ],
    async (baseUrl, runs) => {
      const input: JsonRecord[] = [userMessage("Start.")];
      const first = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        input
      });
      const body = (await first.json()) as { output: JsonRecord[] };
      const next = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        input: [...input, ...body.output, userMessage("Continue")]
      });
      assert.equal(next.status, 503);
      assert.match(
        ((await next.json()) as { error: { message: string } }).error.message,
        /answered in chat conv-b, not conv-a/u
      );
      // Answered after sending: not retried into the same chat.
      assert.equal(runs.requests.length, 2);
    }
  );
});

interface FakeRun {
  readonly requests: OpencliRunRequest[];
  readonly prompts: string[];
}

async function withBridge(
  replies: Array<JsonRecord | Error>,
  body: (baseUrl: string, runs: FakeRun) => Promise<void>,
  authToken = ""
): Promise<void> {
  const runs: FakeRun = { requests: [], prompts: [] };
  const tempRoot = mkdtempSync(join(tmpdir(), "autodev-opencli-test-"));
  const bridge = createOpencliBridge({
    siteTabs: ONE_TAB_PER_SITE,
    authToken,
    turnTimeoutSeconds: 30,
    tempRoot,
    sessionBusyRetryMs: 1,
    unsentRetryMs: 1,
    run: async (request) => {
      // Model switches and listings are answered here, not from `replies`.
      if (request.args[1] === "model")
        return [{ Status: "ok", Model: String(request.args[2]) }];
      if (request.args[1] === "models")
        return [{ model: "3.8-flash" }, { model: "3.1-pro" }];
      runs.requests.push(request);
      if (request.args[0] === "daemon") return [];
      const fileIndex = request.args.indexOf("--file");
      if (request.args[1] === "ask" || request.args[1] === "ask-file")
        runs.prompts.push(
          fileIndex === -1
            ? String(request.args[2])
            : readFileSync(String(request.args[fileIndex + 1]), "utf8")
        );
      const reply = replies.shift();
      if (!reply) throw new Error("no fake reply left");
      if (reply instanceof Error) throw reply;
      return [reply];
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
        model: "opencli-chatgpt-balanced",
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
      // A round trip costs minutes, so the model is told to batch independent
      // calls into one reply rather than spend a turn on each.
      assert.match(runs.prompts[0]!, /await Promise\.all/u);
      assert.match(runs.prompts[0]!, /never repeat a call whose result/u);
      assert.match(runs.prompts[0]!, /Be brief\./u);
      assert.match(runs.prompts[0]!, /### `exec`/u);
      assert.match(runs.prompts[0]!, /Which directory is this\?/u);
      assert.ok(runs.requests[0]!.args.includes("--new"));

      const second = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
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
      // A follow-up is small: the chat keeps its own history, so the full
      // rules and tool reference are not re-sent -- only the call syntax and
      // an index of the tools.
      assert.doesNotMatch(runs.prompts[1]!, /## How to respond/u);
      assert.doesNotMatch(runs.prompts[1]!, /### `exec`/u);
      assert.match(runs.prompts[1]!, /<tool_call name="TOOL_NAME">/u);
      assert.match(runs.prompts[1]!, /- `exec`/u);
      assert.ok(runs.prompts[1]!.length < runs.prompts[0]!.length);
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
        "Gemini reply could not be read",
        "COMMAND_EXEC",
        1
      )
    ],
    async (baseUrl) => {
      const payload = { model: "opencli-chatgpt-balanced", input: "hi" };
      const limited = await post(baseUrl, payload);
      assert.equal(limited.status, 429);
      assert.equal(
        limited.headers.get("x-autodev-limit-class"),
        "quota_exhausted"
      );
      const timedOut = await post(baseUrl, payload);
      assert.equal(timedOut.status, 408);
      const broken = await post(baseUrl, {
        model: "opencli-gemini-3.8-flash",
        input: "hi"
      });
      assert.equal(broken.status, 503);
      assert.match(
        ((await broken.json()) as { error: { message: string } }).error.message,
        /Gemini reply could not be read/u
      );
    }
  );
});

test("the bridge refuses requests it cannot serve before running opencli", async () => {
  await withBridge(
    [],
    async (baseUrl, runs) => {
      const unauthorized = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        input: "hi"
      });
      assert.equal(unauthorized.status, 401);
      const auth = { authorization: "Bearer secret" };
      const unknown = await post(
        baseUrl,
        { model: "opencli-minimax-m3", input: "hi" },
        auth
      );
      assert.equal(unknown.status, 400);
      const image = await post(
        baseUrl,
        {
          model: "opencli-chatgpt-balanced",
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
        [
          ...CHATGPT_MODELS.map((level) => `opencli-chatgpt-${level}`),
          "opencli-gemini-3.8-flash",
          "opencli-gemini-3.1-pro"
        ]
      );
    },
    "secret"
  );
});

test("an orchestrator turn carries the full orchestrator role prompt, a leaf turn none", async () => {
  await withBridge(
    [
      { response: "Delegating.", conversation_id: "c1" },
      { response: "Done.", conversation_id: "c1" },
      { response: "Leaf answer.", conversation_id: "c2" }
    ],
    async (baseUrl, runs) => {
      const orchestrator = { "x-autodev-agent-role": "orchestrator" };
      const input: JsonRecord[] = [userMessage("Fix the bug.")];
      const first = await post(
        baseUrl,
        { model: "opencli-chatgpt-balanced", tools: [EXEC_TOOL], input },
        orchestrator
      );
      const firstBody = (await first.json()) as { output: JsonRecord[] };
      await post(
        baseUrl,
        {
          model: "opencli-chatgpt-balanced",
          tools: [EXEC_TOOL],
          input: [...input, ...firstBody.output, userMessage("Continue.")]
        },
        orchestrator
      );
      // Codex truncates the hook-injected root policy, so the bridge adds the
      // whole role prompt to the conversation's first message; a follow-up
      // only reminds the model it is orchestrating.
      assert.match(runs.prompts[0]!, /## Your role/u);
      assert.match(runs.prompts[0]!, /Root orchestrator bootstrap/u);
      assert.match(runs.prompts[0]!, /Canonical orchestration skill/u);
      assert.doesNotMatch(runs.prompts[1]!, /Root orchestrator bootstrap/u);
      assert.match(runs.prompts[1]!, /still the root orchestrator/u);
      await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        tools: [EXEC_TOOL],
        input: [userMessage("Read a file.")]
      });
      assert.doesNotMatch(runs.prompts[2]!, /## Your role/u);
    }
  );
});

test("an empty site model list is not cached", async () => {
  let listings = 0;
  const bridge = createOpencliBridge({
    siteTabs: ONE_TAB_PER_SITE,
    authToken: "",
    turnTimeoutSeconds: 30,
    run: async (request) => {
      if (request.args[1] !== "models") throw new Error("unexpected command");
      listings += 1;
      return listings === 1 ? [] : [{ model: "3.1-pro" }];
    }
  });
  const server: Server = createServer((request, response) => {
    void bridge.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const ids = async () =>
      (
        (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as {
          data: Array<{ id: string }>;
        }
      ).data
        .map((model) => model.id)
        .filter((id) => id.startsWith("opencli-gemini-"));
    assert.deepEqual(await ids(), []);
    // The empty read was retried rather than kept for five minutes.
    assert.deepEqual(await ids(), ["opencli-gemini-3.1-pro"]);
    assert.deepEqual(await ids(), ["opencli-gemini-3.1-pro"]);
    assert.equal(listings, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a provider's model listing answers from cache and 503s before any list is read", async () => {
  let listings = 0;
  let release: () => void = () => {};
  const bridge = createOpencliBridge({
    siteTabs: ONE_TAB_PER_SITE,
    authToken: "",
    turnTimeoutSeconds: 30,
    run: async (request) => {
      if (request.args[1] !== "models") throw new Error("unexpected command");
      listings += 1;
      // The site reads slowly, as a browser picker does.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [{ model: "3.1-pro" }];
    }
  });
  const server: Server = createServer((request, response) => {
    void bridge.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const list = (provider: string) =>
    fetch(`http://127.0.0.1:${port}/v1/models?provider=${provider}`);
  try {
    // ChatGPT's list is static: no site read, and no wait behind Gemini's.
    const chatgpt = (await (await list("opencli-chatgpt")).json()) as {
      data: Array<{ id: string }>;
    };
    assert.ok(
      chatgpt.data.every(({ id }) => id.startsWith("opencli-chatgpt-"))
    );
    // Gemini has no list yet and its read outlasts the first wait.
    const pending = await list("opencli-gemini");
    assert.equal(pending.status, 503);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const gemini = (await (await list("opencli-gemini")).json()) as {
      data: Array<{ id: string }>;
    };
    assert.deepEqual(
      gemini.data.map(({ id }) => id),
      ["opencli-gemini-3.1-pro"]
    );
    assert.equal(listings, 1);
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a signed-out site reports sign-in required until it lists again", async () => {
  // A Gemini tab signed in as an account without the Gemini app shows the
  // landing page, and the adapter refuses it as AUTH_REQUIRED. The bridge
  // used to answer its health check `ok` regardless, so the provider read
  // Ready while every listing and turn failed.
  let signedIn = false;
  const bridge = createOpencliBridge({
    siteTabs: ONE_TAB_PER_SITE,
    authToken: "",
    turnTimeoutSeconds: 30,
    run: async (request) => {
      if (request.args[1] !== "models") throw new Error("unexpected command");
      if (!signedIn)
        throw new OpencliCommandError(
          "The Gemini app is not available to the signed-in Google account work@example.com",
          "AUTH_REQUIRED",
          77
        );
      return [{ model: "3.1-pro" }];
    }
  });
  const server: Server = createServer((request, response) => {
    void bridge.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const listing = await fetch(`${base}/v1/models?provider=opencli-gemini`);
    assert.equal(listing.status, 401);
    const body = (await listing.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, "sign_in_required");
    assert.match(body.error.message, /work@example\.com/u);

    const health = await fetch(
      `${base}/health/liveliness?provider=opencli-gemini`
    );
    assert.equal(health.status, 401);
    assert.equal(
      ((await health.json()) as { error: { code: string } }).error.code,
      "sign_in_required"
    );
    // The other site is not signed out.
    assert.equal(
      (await fetch(`${base}/health/liveliness?provider=opencli-chatgpt`))
        .status,
      200
    );

    signedIn = true;
    const relisted = (await (
      await fetch(`${base}/v1/models?provider=opencli-gemini`)
    ).json()) as { data: Array<{ id: string }> };
    assert.deepEqual(
      relisted.data.map(({ id }) => id),
      ["opencli-gemini-3.1-pro"]
    );
    assert.equal(
      (await fetch(`${base}/health/liveliness?provider=opencli-gemini`)).status,
      200
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the follow-up tool index names exec's nested functions", () => {
  const index = toolIndex([
    {
      kind: "custom",
      name: "exec",
      description:
        "Run JavaScript.\ndeclare const tools: {\n  exec_command(args: { cmd: string }): Promise<string>;\n  multi_agent_v1__wait_agent(args: { targets: string[] }): Promise<unknown>;\n};\ntext(value)",
      parameters: null,
      namespace: null
    },
    {
      kind: "function",
      name: "wait",
      description: "Wait for a running cell.",
      parameters: {},
      namespace: null
    }
  ]);
  assert.match(index, /- `exec`: Run JavaScript\./u);
  assert.match(index, /`exec_command`, `multi_agent_v1__wait_agent`/u);
  // `text(` is not a snake_case tool name.
  assert.doesNotMatch(index, /`text`/u);
  assert.match(index, /- `wait`: Wait for a running cell\./u);
});

test("a slow streamed turn keeps Codex's idle timer alive with real events", async () => {
  let release: () => void = () => {};
  const bridge = createOpencliBridge({
    siteTabs: ONE_TAB_PER_SITE,
    authToken: "",
    turnTimeoutSeconds: 30,
    keepAliveMs: 5,
    run: async (request) => {
      if (request.args[1] === "model")
        return [{ Status: "ok", Model: String(request.args[2]) }];
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [{ response: "done", conversation_id: "c1" }];
    }
  });
  const server: Server = createServer((request, response) => {
    void bridge.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await post(`http://127.0.0.1:${port}`, {
      model: "opencli-chatgpt-balanced",
      stream: true,
      input: "hi"
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    release();
    const events = await response.text();
    // An SSE comment is dropped by the client's parser and never resets its
    // idle timer; a `response.in_progress` event does.
    assert.ok(
      (events.match(/event: response\.in_progress/gu) ?? []).length >= 2
    );
    assert.doesNotMatch(events, /^: /mu);
    assert.match(events, /event: response\.completed/u);
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a command the site was not ready for is retried, because nothing was sent", async () => {
  await withBridge(
    [
      new OpencliCommandError(
        "ChatGPT ask-file requires an authenticated session with an active composer.",
        "COMMAND_EXEC",
        1
      ),
      { response: "done", conversation_id: "c1" }
    ],
    async (baseUrl, runs) => {
      const reply = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        input: "hi"
      });
      assert.equal(reply.status, 200);
      assert.equal(runs.requests.length, 2);
    }
  );
});

test("a failure after sending is not retried, so the prompt is never sent twice", async () => {
  await withBridge(
    [
      new OpencliCommandError("Failed to read ChatGPT reply", "COMMAND_EXEC", 1)
    ],
    async (baseUrl, runs) => {
      const reply = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        input: "hi"
      });
      assert.equal(reply.status, 503);
      assert.equal(runs.requests.length, 1);
    }
  );
});

test("a site that was not ready is a refusal, and the provider keeps serving", async () => {
  // The prompt never reached the site: the tab had no composer. The provider
  // is healthy and holds nothing of this turn, so the turn is refused rather
  // than reported as a provider outage -- cooling the provider down would
  // push every other agent away from a working route because one browser tab
  // was not ready yet.
  const notReady = new OpencliCommandError(
    "ChatGPT ask-file requires an authenticated session with an active composer.",
    "COMMAND_EXEC",
    1
  );
  await withBridge([notReady, notReady, notReady], async (baseUrl) => {
    const reply = await post(baseUrl, {
      model: "opencli-chatgpt-balanced",
      input: "hi"
    });
    assert.equal(reply.status, 400);
    const body = (await reply.json()) as { error: { type: string } };
    assert.equal(body.error.type, "provider_request_unsupported");
  });
});

test("a streamed turn that never reached the site says so in the stream", async () => {
  // The same refusal, in the stream: the router reads the error the turn
  // failed with, and a route that cannot serve the request is not a provider
  // that is down.
  const bridge = createOpencliBridge({
    siteTabs: ONE_TAB_PER_SITE,
    authToken: "",
    turnTimeoutSeconds: 30,
    sessionBusyRetryMs: 1,
    unsentRetryMs: 1,
    run: async () => {
      throw new OpencliCommandError("file input is missing", "COMMAND_EXEC", 1);
    }
  });
  const server: Server = createServer((request, response) => {
    void bridge.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await post(`http://127.0.0.1:${port}`, {
      model: "opencli-chatgpt-balanced",
      stream: true,
      input: "hi"
    });
    assert.equal(response.status, 200);
    const events = await response.text();
    assert.match(events, /event: response\.failed/u);
    assert.match(events, /"type":"provider_request_unsupported"/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a daemon of another version is stopped, and the command runs again", async () => {
  // opencli's daemon is shared machine-wide, so the CLI of the version this
  // repository pins can meet the daemon of another one. The CLI's own remedy
  // is to stop the daemon by hand; the bridge owns the CLI it runs, so it
  // does that itself instead of failing the turn.
  await withBridge(
    [
      new OpencliCommandError(
        "Stale daemon could not be replaced (A stale daemon (v2.0.3 ≠ v2.0.2) is running but did not shut down (graceful + SIGKILL both failed). Run manually: opencli daemon stop)",
        "COMMAND_EXEC",
        1
      ),
      { response: "done", conversation_id: "c1" }
    ],
    async (baseUrl, runs) => {
      const reply = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        input: "hi"
      });
      assert.equal(reply.status, 200);
      assert.ok(
        runs.requests.some((request) => request.args[0] === "daemon"),
        "the stale daemon was not stopped"
      );
      assert.equal(runs.prompts.length, 2, "the turn ran the command twice");
    }
  );
});

test("a busy site session is waited out instead of failing the turn", async () => {
  await withBridge(
    [
      new OpencliCommandError(
        'Session "site:chatgpt" is busy: chatgpt/ask (pid 1) has been driving it for 30s.',
        "SESSION_BUSY",
        1
      ),
      { response: "done", conversation_id: "c1" }
    ],
    async (baseUrl, runs) => {
      const reply = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        input: "hi"
      });
      assert.equal(reply.status, 200);
      assert.equal(runs.requests.length, 2);
    }
  );
});

test("a Gemini worker turn continues its web conversation with only the new items", async () => {
  await withBridge(
    [
      {
        response:
          '💬 <tool_call name="exec">\ntext(await tools.exec_command({cmd: "ls"}));\n</tool_call>',
        url: "https://gemini.google.com/app/abc123"
      },
      { response: "💬 Listed.", url: "https://gemini.google.com/app/abc123" }
    ],
    async (baseUrl, runs) => {
      const input: JsonRecord[] = [userMessage("List the files.")];
      const first = await post(baseUrl, {
        model: "opencli-gemini-3.8-flash",
        tools: [EXEC_TOOL],
        input
      });
      const firstBody = (await first.json()) as { output: JsonRecord[] };
      const call = firstBody.output.find(
        (item) => item.type === "custom_tool_call"
      )!;
      const second = await post(baseUrl, {
        model: "opencli-gemini-3.8-flash",
        tools: [EXEC_TOOL],
        input: [
          ...input,
          ...firstBody.output,
          {
            type: "custom_tool_call_output",
            call_id: call.call_id,
            output: "a.txt\nb.txt\n"
          }
        ]
      });
      assert.equal(second.status, 200);
      // The chat is the one the first answer came from: no `status` runs
      // after an answer, since it can read another Gemini tab -- one such
      // read sent a subagent's follow-ups into another session's chat.
      assert.deepEqual(
        runs.requests.map(({ args }) => args[1]),
        ["ask", "ask"]
      );
      const continuedArgs = runs.requests[1]!.args;
      assert.equal(
        continuedArgs[continuedArgs.indexOf("--conversation") + 1],
        "abc123"
      );
      assert.match(runs.prompts[1]!, /a\.txt/u);
      assert.doesNotMatch(runs.prompts[1]!, /List the files\./u);
    }
  );
});

/** A code-mode `exec` description shaped like Codex's, with many MCP tools. */
function codeModeDescription(mcpTools: number): string {
  const section = (name: string, summary: string) =>
    `### \`${name}\`\n${summary}\n\n\`\`\`ts\ndeclare const tools: { ${name}(args: {\n  ${"field: string; ".repeat(40)}\n}): Promise<unknown>; };\n\`\`\`\n`;
  return [
    "Run JavaScript code to orchestrate/compose tool calls",
    "- All nested tools are available on the global `tools` object.",
    "",
    section("exec_command", "Runs a command in a PTY, returning output."),
    section("multi_agent_v1__spawn_agent", "Spawn a child agent for a task."),
    "## mcp__codex_apps",
    "Connector tools for GitHub and more.",
    "",
    ...Array.from({ length: mcpTools }, (_, index) =>
      section(
        `mcp__codex_apps__github_tool_${index}`,
        `GitHub operation number ${index}.`
      )
    )
  ].join("\n");
}

test("a code-mode reference lists MCP tools by name and keeps the built-in tools whole", () => {
  const full = codeModeDescription(3);
  const compact = compactCodeModeDescription(full);
  // Built-in tools keep their whole section, declaration included.
  assert.match(compact, /### `exec_command`\nRuns a command in a PTY/u);
  assert.match(
    compact,
    /declare const tools: \{ multi_agent_v1__spawn_agent\(/u
  );
  // An MCP tool keeps its name and summary, not its declaration.
  assert.match(
    compact,
    /- `mcp__codex_apps__github_tool_1`: GitHub operation number 1\./u
  );
  assert.doesNotMatch(compact, /declare const tools: \{ mcp__/u);
  assert.match(compact, /## mcp__codex_apps\nConnector tools for GitHub/u);
  // And the model is told how to read the rest before calling one.
  assert.match(compact, /The 3 `mcp__\*` tools above are listed by name only/u);
  assert.match(compact, /ALL_TOOLS\.find/u);
  // A description with no MCP tools is unchanged in substance.
  const builtIn = codeModeDescription(0);
  assert.doesNotMatch(compactCodeModeDescription(builtIn), /listed by name/u);
});

test("a Gemini root whose full tool reference is too long starts with MCP tools named", async () => {
  // A root orchestrator in the Codex app carries enough connector tools that
  // its first prompt reached 300 KB, which Gemini's composer could not take:
  // every Gemini root failed at once with a 400.
  const exec = {
    type: "custom",
    name: "exec",
    description: codeModeDescription(600)
  };
  assert.ok(Buffer.byteLength(exec.description) > 300_000);
  await withBridge(
    [{ response: "💬 ok", url: "https://gemini.google.com/app/root1" }],
    async (baseUrl, runs) => {
      const response = await post(baseUrl, {
        model: "opencli-gemini-3.1-pro",
        tools: [exec],
        input: [userMessage("Plan the work.")]
      });
      assert.equal(response.status, 200);
      const prompt = runs.prompts[0]!;
      assert.ok(Buffer.byteLength(prompt) < 100_000, `${prompt.length}`);
      assert.match(prompt, /declare const tools: \{ exec_command\(/u);
      assert.match(prompt, /- `mcp__codex_apps__github_tool_599`/u);
      assert.match(prompt, /listed by name only/u);
      assert.match(prompt, /Plan the work\./u);
    }
  );
  // ChatGPT takes the prompt as an attachment, so the page takes it whatever
  // its size, but the model still has to read it: a 300 KB reference took the
  // model 85 seconds to say anything. The reference is compressed for the
  // model too, and the built-in tools keep their declarations. A reference
  // that fits ChatGPT's typed limit only with MCP tools named is named, so
  // the prompt is typed rather than spending one of the account's uploads.
  await withBridge(
    [{ response: "ok", conversation_id: "c-root" }],
    async (baseUrl, runs) => {
      const response = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        tools: [exec],
        input: [userMessage("Plan the work.")]
      });
      assert.equal(response.status, 200);
      const prompt = runs.prompts[0]!;
      assert.ok(
        Buffer.byteLength(prompt) < Buffer.byteLength(exec.description),
        `the attached prompt kept the whole reference: ${prompt.length}`
      );
      assert.match(prompt, /declare const tools: \{ exec_command\(/u);
      assert.match(
        prompt,
        /`mcp__codex_apps__github_tool_598`, `mcp__codex_apps__github_tool_599`/u
      );
      assert.match(prompt, /listed by name only/u);
      assert.ok(Buffer.byteLength(prompt) <= 32_000, `${prompt.length}`);
      assert.doesNotMatch(
        prompt,
        /declare const tools: \{ mcp__codex_apps__github_tool_599\(/u
      );
    }
  );
});

test("a Gemini root with too many MCP tools even for summaries lists them by name", async () => {
  const exec = {
    type: "custom",
    name: "exec",
    description: codeModeDescription(2000)
  };
  await withBridge(
    [{ response: "💬 ok", url: "https://gemini.google.com/app/root2" }],
    async (baseUrl, runs) => {
      const response = await post(baseUrl, {
        model: "opencli-gemini-3.1-pro",
        tools: [exec],
        input: [userMessage("Plan the work.")]
      });
      assert.equal(response.status, 200);
      const prompt = runs.prompts[0]!;
      assert.ok(Buffer.byteLength(prompt) < 100_000, `${prompt.length}`);
      assert.match(prompt, /`mcp__codex_apps__github_tool_1999`/u);
      assert.doesNotMatch(prompt, /GitHub operation number 1999/u);
      assert.match(prompt, /The 2000 `mcp__\*` tools above/u);
      assert.match(prompt, /declare const tools: \{ exec_command\(/u);
    }
  );
});

test("a Gemini prompt still too long once compacted is refused before opencli runs", async () => {
  await withBridge([], async (baseUrl, runs) => {
    const response = await post(baseUrl, {
      model: "opencli-gemini-3.1-pro",
      input: [userMessage("x".repeat(120_000))]
    });
    assert.equal(response.status, 400);
    assert.match(
      ((await response.json()) as { error: { message: string } }).error.message,
      /takes at most 100000/u
    );
    assert.equal(runs.requests.length, 0);
  });
});

test("a Gemini chat too far behind for its command line starts a new chat that fits", async () => {
  // A session whose turns went to another route while Gemini was down came
  // back to its Gemini chat with the whole gap to catch up on: an
  // opencli-gemini root was refused every turn with a 345 KB continuation
  // while its compacted first prompt was 95 KB.
  const filler = "x".repeat(20_000);
  await withBridge(
    [
      { response: "💬 first", url: "https://gemini.google.com/app/old" },
      { response: "💬 caught up", url: "https://gemini.google.com/app/new" }
    ],
    async (baseUrl, runs) => {
      const input: JsonRecord[] = [userMessage("Plan the work.")];
      const first = await post(baseUrl, {
        model: "opencli-gemini-3.1-pro",
        input
      });
      assert.equal(first.status, 200);
      const { output } = (await first.json()) as { output: JsonRecord[] };
      const behind = [
        ...input,
        ...output,
        ...Array.from({ length: 8 }, (_, index) =>
          userMessage(`step ${index}: ${filler}`)
        ),
        userMessage("the newest message")
      ];
      const second = await post(baseUrl, {
        model: "opencli-gemini-3.1-pro",
        input: behind
      });
      assert.equal(second.status, 200);
      const asks = runs.requests.filter((request) => request.args[1] === "ask");
      assert.equal(asks.length, 2);
      // Not a continuation of the old chat...
      assert.equal(asks[1]!.args.includes("--conversation"), false);
      // ...but a new one, with the conversation shortened to fit.
      const prompt = runs.prompts[1]!;
      assert.ok(Buffer.byteLength(prompt) <= 100_000, `${prompt.length}`);
      assert.match(prompt, /left out to keep it within the site's limit/u);
      assert.match(prompt, /Plan the work\./u);
      assert.match(prompt, /the newest message/u);
    }
  );
});

test("a conversation that outgrew the site is shortened, and says what it left out", async () => {
  // The prompt a new chat gets is the whole conversation, and the
  // conversation grows with every tool result. A root session that had run
  // dozens of tools sent 169 KB of transcript to ChatGPT on every new chat
  // (session 01a1c6a9-dc62-7a10-ac7e-a20047d5489d), and the model read all
  // of it before it said anything.
  const filler = "x".repeat(20_000);
  const input = [
    userMessage("Plan the work."),
    ...Array.from({ length: 12 }, (_, index) =>
      userMessage(`step ${index}: ${filler}`)
    ),
    userMessage("the last thing the model said")
  ];
  await withBridge(
    [{ response: "ok", conversation_id: "c-long" }],
    async (baseUrl, runs) => {
      const response = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        input
      });
      assert.equal(response.status, 200);
      const prompt = runs.prompts[0]!;
      assert.ok(
        Buffer.byteLength(prompt) <= 120_000,
        `the prompt was ${Buffer.byteLength(prompt)} bytes`
      );
      assert.match(prompt, /Plan the work\./u);
      assert.match(prompt, /the last thing the model said/u);
      assert.match(
        prompt,
        /earlier message[s]? of this conversation left out/u
      );
      assert.doesNotMatch(prompt, /step 0:/u);
    }
  );
});

test("a conversation is not shortened when the tool reference is what is too long", async () => {
  // A built-in tool's declaration is kept whole, so a reference can be over
  // the limit on its own. Shortening the conversation would not make the
  // prompt fit, and the conversation is what the turn is.
  const exec = {
    type: "custom",
    name: "exec",
    description: [
      "Run JavaScript code to orchestrate/compose tool calls",
      "",
      "### `exec_command`",
      `Runs a command in a PTY. ${"x".repeat(150_000)}`,
      ""
    ].join("\n")
  };
  await withBridge(
    [{ response: "ok", conversation_id: "c-big-reference" }],
    async (baseUrl, runs) => {
      const response = await post(baseUrl, {
        model: "opencli-chatgpt-balanced",
        tools: [exec],
        input: [
          userMessage("Plan the work."),
          userMessage("the second message")
        ]
      });
      assert.equal(response.status, 200);
      const prompt = runs.prompts[0]!;
      assert.match(prompt, /the second message/u);
      assert.doesNotMatch(prompt, /left out to keep it within/u);
    }
  );
});

test("a conversation is left alone when it fits", () => {
  const segments = ["one", "two", "three"];
  const compacted = compactTranscript(segments, 100_000);
  assert.equal(compacted.dropped, 0);
  assert.equal(compacted.text, "one\n\ntwo\n\nthree");
});

test("the middle of a conversation is what is left out", () => {
  const segments = ["the task", "old".repeat(100), "old".repeat(100), "recent"];
  const compacted = compactTranscript(segments, 400);
  assert.equal(compacted.dropped, 2);
  assert.match(compacted.text, /^the task/u);
  assert.match(
    compacted.text,
    /2 earlier messages of this conversation left out/u
  );
  assert.match(compacted.text, /recent$/u);
  assert.doesNotMatch(compacted.text, /old/u);
});

test("a single message larger than the budget is not cut", () => {
  // The task is what the model works from: a conversation that is one
  // message is the task, and there is nothing to leave out.
  const compacted = compactTranscript(["x".repeat(500)], 100);
  assert.equal(compacted.dropped, 0);
  assert.equal(compacted.text.length, 500);
});

test("the installed opencli accepts every flag the site specs pass", async () => {
  // The specs are tested against fakes; this is the real CLI's parser. A flag
  // AutoDev's patch adds to a command's code but not to opencli's manifest is
  // refused as an unknown option -- every continued Gemini turn once was.
  const used = new Map<string, Set<string>>();
  const record = async (args: readonly string[]) => {
    const command = `${args[0]} ${args[1]}`;
    const flags = used.get(command) ?? new Set<string>();
    for (const arg of args) if (arg.startsWith("--")) flags.add(arg.slice(2));
    used.set(command, flags);
    return [
      {
        response: "ok",
        conversation_id: "c1",
        url: "https://gemini.google.com/app/c1"
      }
    ];
  };
  for (const site of ["chatgpt", "gemini"] as const)
    for (const conversationId of [null, "c1"])
      await OPENCLI_SITE_SPECS[site].turn(
        {
          prompt: "p",
          promptFile: "/tmp/turn.md",
          // A continued ChatGPT turn is the typed one, so both ways a prompt
          // reaches the site are checked against the CLI.
          typed: site === "chatgpt" && conversationId !== null,
          conversationId,
          siteModel: site === "chatgpt" ? "balanced" : "3.1-pro",
          siteThinking: null,
          selectModel: true,
          timeoutSeconds: 60
        },
        record
      );
  const opencli = resolveOpencliCommand();
  for (const [command, flags] of used) {
    const help = spawnSync(
      opencli.command,
      [...opencli.args, ...command.split(" "), "--help", "-f", "json"],
      { encoding: "utf8" }
    );
    assert.equal(help.status, 0, help.stderr);
    const declared = new Set(
      (
        JSON.parse(help.stdout) as { command_options: Array<{ name: string }> }
      ).command_options.map(({ name }) => name)
    );
    declared.add("format");
    for (const flag of flags)
      assert.ok(declared.has(flag), `opencli ${command} has no --${flag}`);
  }
  assert.ok(used.get("gemini ask")?.has("conversation"));
  assert.ok(used.get("chatgpt ask-file")?.has("inline"));
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
      `CODEX_ROUTER_OPENCLI_API_KEY=${token}\nOPENCLI_GEMINI_ACCOUNT=someone@example.com\n`,
      { mode: 0o600 }
    );
    writeFileSync(
      fakeNode,
      '#!/bin/sh\nprintf "%s %s %s %s" "${CODEX_ROUTER_OPENCLI_API_KEY:-}" "$OPENCLI_PROXY_PORT" "${OPENCLI_GEMINI_ACCOUNT:-}" "$1" > "$OPENCLI_CAPTURE"\n',
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
      `${token} 4004 someone@example.com ${join(codexHome, "src", "providers", "opencli.ts")}`
    );
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
