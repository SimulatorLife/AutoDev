import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createOpencliBridge,
  type OpencliRunRequest
} from "@simulatorlife/autodev-runtime/providers/opencli";
import {
  OpencliCommandError,
  OpencliConversationLedger
} from "@simulatorlife/autodev-runtime/providers/opencli-turn";

/**
 * Every prompt reaches the chat of the agent that sent it, and every reply
 * goes back to that agent.
 *
 * The bridge is driven over HTTP against a simulated ChatGPT and Gemini: each
 * site keeps its chats (what was sent into each) and the one tab opencli
 * drives (which chat it shows). The simulation follows the opencli contract
 * the bridge relies on -- `--conversation <id>` opens that chat, `--new` a new
 * one, and a prompt is sent only if the tab shows the turn's chat at the moment
 * of sending (AutoDev's opencli patch), otherwise the command fails with
 * "prompt was not sent" -- and it can move the tab the way someone clicking in
 * the browser would, or leave a reply running the way an interrupted turn
 * does.
 *
 * Every agent's messages carry its own marker, so a prompt that reached the
 * wrong chat is visible in that chat's history.
 */

type JsonRecord = Record<string, unknown>;
type Site = "chatgpt" | "gemini";

const EXEC_TOOL = {
  type: "custom",
  name: "exec",
  description: "Run JavaScript against the `tools` global."
};

const MODEL: Record<Site, string> = {
  chatgpt: "opencli-chatgpt-balanced",
  gemini: "opencli-gemini-3.1-pro"
};

function userMessage(text: string): JsonRecord {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }]
  };
}

function toolOutput(callId: string, output: string): JsonRecord {
  return { type: "custom_tool_call_output", call_id: callId, output };
}

interface SiteState {
  /** What was sent into each chat, in order. */
  readonly chats: Map<string, string[]>;
  /** The chat the driven tab shows; null on a new-chat page. */
  tab: string | null;
  /** Chats with a reply still being written that nobody waits for. */
  readonly stale: Set<string>;
  /** Chats where a stale reply was stopped before a prompt was sent. */
  readonly stopped: string[];
  /** Runs once before the next send, after the chat was opened. */
  beforeSend: (() => void) | null;
  nextId: number;
}

class FakeSites {
  readonly sites: Record<Site, SiteState> = {
    chatgpt: this.empty(),
    gemini: this.empty()
  };
  /** Prompt markers that make the site keep answering until cancelled. */
  readonly slow = new Set<string>();

  private empty(): SiteState {
    return {
      chats: new Map(),
      tab: null,
      stale: new Set(),
      stopped: [],
      beforeSend: null,
      nextId: 0
    };
  }

  /** Someone opens another chat in the driven tab. */
  showOtherChat(site: Site): string {
    const state = this.sites[site];
    const id = `${site}-other-${++state.nextId}`;
    state.chats.set(id, []);
    state.tab = id;
    return id;
  }

  readonly run = async ({
    args,
    signal
  }: OpencliRunRequest): Promise<JsonRecord[]> => {
    const site = args[0] as Site;
    const command = args[1];
    if (command === "model") return [{ Status: "ok", Model: args[2] }];
    if (command === "models") return [{ model: "3.1-pro" }];
    if (command !== "ask" && command !== "ask-file")
      throw new Error(`unexpected opencli command ${args.join(" ")}`);
    const state = this.sites[site];
    const at = args.indexOf("--conversation");
    const expected = at === -1 ? null : String(args[at + 1]);
    const fresh = args.includes("--new");
    assert.ok(
      fresh !== (expected !== null),
      "every turn names its chat or asks for a new one"
    );
    // Open the chat the turn asked for.
    if (expected !== null) {
      if (!state.chats.has(expected))
        throw new OpencliCommandError(
          `No turns were visible in chat ${expected}; prompt was not sent`,
          "EMPTY_RESULT",
          66
        );
      state.tab = expected;
    } else state.tab = null;
    if (state.tab !== null && state.stale.delete(state.tab))
      state.stopped.push(state.tab);
    const interfere = state.beforeSend;
    state.beforeSend = null;
    interfere?.();
    // The check on the sending page, right before sending.
    if (state.tab !== expected)
      throw new OpencliCommandError(
        `the tab shows chat ${state.tab ?? "none"}, not ${expected ?? "a new chat"}; prompt was not sent`,
        "COMMAND_EXEC",
        1
      );
    const prompt = await this.promptOf(args);
    let chat = state.tab;
    if (chat === null) {
      chat = `${site}-${++state.nextId}`;
      state.chats.set(chat, []);
      state.tab = chat;
    }
    state.chats.get(chat)!.push(prompt);
    const slow = [...this.slow].find((marker) => prompt.includes(marker));
    if (slow) {
      this.slow.delete(slow);
      // The site goes on answering after its caller stops listening.
      state.stale.add(chat);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      throw new OpencliCommandError("turn cancelled", "CANCELLED", null);
    }
    const response = prompt.includes("SAME_REPLY")
      ? "On it."
      : prompt.includes("NEEDS_TOOL")
      ? '<tool_call name="exec">\ntext("look");\n</tool_call>'
      : `answered in ${chat}`;
    return [
      site === "chatgpt"
        ? { response, conversation_id: chat }
        : { response: `💬 ${response}`, url: `https://gemini.google.com/app/${chat}` }
    ];
  };

  private async promptOf(args: readonly string[]): Promise<string> {
    const file = args.indexOf("--file");
    if (file === -1) return String(args[2]);
    const { readFile } = await import("node:fs/promises");
    return readFile(String(args[file + 1]), "utf8");
  }

  /** Every chat a marker's messages were sent into. */
  chatsWith(marker: string): string[] {
    const found: string[] = [];
    for (const state of Object.values(this.sites))
      for (const [id, prompts] of state.chats)
        if (prompts.some((prompt) => prompt.includes(marker))) found.push(id);
    return found;
  }
}

interface Agent {
  readonly marker: string;
  readonly site: Site;
  readonly thread: string;
  /** Where Codex names the thread: its turn-metadata header or the body. */
  readonly via: "header" | "body";
  input: JsonRecord[];
}

function agent(
  marker: string,
  site: Site,
  thread: string,
  via: Agent["via"] = "header",
  task = `${marker}: start NEEDS_TOOL`
): Agent {
  return { marker, site, thread, via, input: [userMessage(task)] };
}

/** Subagents spawned with the same task: identical until their tools answer. */
const TWIN_TASK = "Review the renderer. NEEDS_TOOL";

async function withSites(
  body: (
    send: (agent: Agent, signal?: AbortSignal) => Promise<Response>,
    sites: FakeSites,
    ledger: OpencliConversationLedger
  ) => Promise<void>
): Promise<void> {
  const sites = new FakeSites();
  const tempRoot = mkdtempSync(join(tmpdir(), "autodev-opencli-routing-"));
  const ledger = new OpencliConversationLedger();
  const bridge = createOpencliBridge({
    authToken: "",
    turnTimeoutSeconds: 30,
    tempRoot,
    ledger,
    sessionBusyRetryMs: 1,
    unsentRetryMs: 1,
    run: sites.run
  });
  const server: Server = createServer((request, response) => {
    void bridge.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (agent: Agent, signal?: AbortSignal) =>
    fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(agent.via === "header"
          ? {
              "x-codex-turn-metadata": JSON.stringify({
                thread_id: agent.thread
              })
            }
          : {})
      },
      body: JSON.stringify({
        model: MODEL[agent.site],
        tools: [EXEC_TOOL],
        input: agent.input,
        ...(agent.via === "body"
          ? { client_metadata: { thread_id: agent.thread } }
          : {})
      }),
      ...(signal ? { signal } : {})
    });
  try {
    await body(send, sites, ledger);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** One request; the reply's items join the agent's transcript, as Codex does. */
async function turn(
  send: (agent: Agent) => Promise<Response>,
  agent: Agent
): Promise<{ text: string; callId: string | null }> {
  const response = await send(agent);
  assert.equal(response.status, 200, `${agent.marker}: ${response.status}`);
  const body = (await response.json()) as {
    output: JsonRecord[];
    output_text: string;
  };
  agent.input.push(...body.output);
  const call = body.output.find((item) => item.type === "custom_tool_call");
  return {
    text: body.output_text,
    callId: typeof call?.call_id === "string" ? call.call_id : null
  };
}

function only(chats: string[], marker: string): string {
  assert.equal(chats.length, 1, `${marker} used one chat, not ${chats}`);
  return chats[0]!;
}

test("concurrent sessions, roots and subagents on both sites each keep their own chat", async () => {
  await withSites(async (send, sites) => {
    // Two sessions, each a root with subagents, spread over both sites. Two
    // pairs of subagents have identical tasks and get identical replies, so
    // only their threads -- named both ways Codex does -- tell them apart.
    const agents = [
      agent("S1-root", "chatgpt", "s1-root"),
      agent("S1-sub-a", "gemini", "s1-sub-a"),
      agent("S1-sub-b", "gemini", "s1-sub-b", "body"),
      agent("S2-root", "gemini", "s2-root", "body"),
      agent("S2-sub-a", "chatgpt", "s2-sub-a", "header", TWIN_TASK),
      agent("S2-sub-b", "chatgpt", "s2-sub-b", "header", TWIN_TASK),
      agent("S2-sub-c", "gemini", "s2-sub-c", "body", TWIN_TASK),
      agent("S2-sub-d", "gemini", "s2-sub-d", "header", TWIN_TASK)
    ];
    // Round 1: every agent at once asks for a tool.
    const calls = await Promise.all(agents.map((a) => turn(send, a)));
    // Round 2: every tool output at once.
    await Promise.all(
      agents.map((a, index) => {
        a.input.push(
          toolOutput(calls[index]!.callId!, `${a.marker}: tool result`)
        );
        return turn(send, a);
      })
    );
    // Round 3: the user sends each a later message at once.
    const finals = await Promise.all(
      agents.map((a) => {
        a.input.push(userMessage(`${a.marker}: Continue`));
        return turn(send, a);
      })
    );
    const chats = new Set<string>();
    agents.forEach((a, index) => {
      const chat = only(sites.chatsWith(a.marker), a.marker);
      assert.ok(chat.startsWith(a.site), `${a.marker} stayed on ${a.site}`);
      chats.add(chat);
      // Each agent's chat holds its three prompts and nobody else's.
      const prompts = sites.sites[a.site].chats.get(chat)!;
      assert.equal(prompts.length, 3, a.marker);
      for (const other of agents)
        if (other !== a)
          assert.ok(
            prompts.every((prompt) => !prompt.includes(`${other.marker}:`)),
            `${other.marker} leaked into ${a.marker}'s chat`
          );
      // And each reply went back to the agent whose chat answered it.
      assert.equal(finals[index]!.text, `answered in ${chat}`);
    });
    assert.equal(chats.size, agents.length);
    // No chat beyond one per agent, and none holding another's first prompt:
    // a twin continued in its sibling's chat would leave its sibling to start
    // over in a chat of its own.
    const all = [
      ...sites.sites.chatgpt.chats.values(),
      ...sites.sites.gemini.chats.values()
    ];
    assert.equal(all.length, agents.length, "one chat per agent");
    for (const prompts of all) assert.equal(prompts.length, 3);
  });
});

test("after an interrupt, the next message continues the same chat and stops the stale reply", async () => {
  await withSites(async (send, sites, ledger) => {
    for (const site of ["chatgpt", "gemini"] as const) {
      const a = agent(`INT-${site}`, site, `int-${site}`);
      const first = await turn(send, a);
      a.input.push(toolOutput(first.callId!, "result"));
      await turn(send, a);
      const chat = only(sites.chatsWith(a.marker), a.marker);
      const entries = ledger.size;

      // The user sends a message, and interrupts while the site answers.
      a.input.push(userMessage(`${a.marker}: long task SLOW-${site}`));
      sites.slow.add(`SLOW-${site}`);
      const controller = new AbortController();
      const pending = send(a, controller.signal).catch(() => null);
      while (!sites.sites[site].stale.has(chat))
        await new Promise((resolve) => setTimeout(resolve, 2));
      controller.abort();
      await pending;
      assert.equal(ledger.size, entries, "an interrupted turn records nothing");

      // Codex marks the turn aborted; the user types "Continue".
      a.input.push(
        userMessage("<turn_aborted>The user interrupted.</turn_aborted>"),
        userMessage(`${a.marker}: Continue`)
      );
      const resumed = await turn(send, a);
      assert.equal(resumed.text, `answered in ${chat}`);
      assert.deepEqual(sites.chatsWith(a.marker), [chat]);
      assert.deepEqual(sites.sites[site].stopped, [chat]);
      // The continuation carries what the chat has not seen from Codex, and
      // not the conversation again from the start.
      const last = sites.sites[site].chats.get(chat)!.at(-1)!;
      assert.match(last, new RegExp(`${a.marker}: Continue`, "u"));
      assert.match(last, /turn_aborted/u);
      assert.doesNotMatch(last, new RegExp(`${a.marker}: start`, "u"));
    }
  });
});

test("a steering message and a queued message reach the agent's own chat", async () => {
  await withSites(async (send, sites) => {
    const a = agent("STEER-A", "gemini", "steer-a");
    const b = agent("STEER-B", "gemini", "steer-b");
    const [callA, callB] = await Promise.all([turn(send, a), turn(send, b)]);
    // A steer arrives mid-turn: Codex sends it after the tool output.
    a.input.push(
      toolOutput(callA.callId!, "result A"),
      userMessage("STEER-A: also check the tests")
    );
    b.input.push(toolOutput(callB.callId!, "result B"));
    await Promise.all([turn(send, a), turn(send, b)]);
    // A message queued while B worked is B's next request.
    b.input.push(userMessage("STEER-B: queued follow-up"));
    await turn(send, b);
    const chatA = only(sites.chatsWith("STEER-A"), "STEER-A");
    const chatB = only(sites.chatsWith("STEER-B"), "STEER-B");
    assert.notEqual(chatA, chatB);
    assert.match(
      sites.sites.gemini.chats.get(chatA)![1]!,
      /also check the tests/u
    );
    assert.match(sites.sites.gemini.chats.get(chatB)!.at(-1)!, /queued/u);
  });
});

test("a chat opened in the tab between turns, or just before sending, never receives the prompt", async () => {
  await withSites(async (send, sites) => {
    for (const site of ["chatgpt", "gemini"] as const) {
      const a = agent(`TAB-${site}`, site, `tab-${site}`);
      const first = await turn(send, a);
      const chat = only(sites.chatsWith(a.marker), a.marker);

      // Between turns someone opens another chat in the tab.
      const between = sites.showOtherChat(site);
      a.input.push(toolOutput(first.callId!, "result"));
      await turn(send, a);

      // After the turn's chat was opened, and before the prompt is sent,
      // someone opens another chat again: that attempt sends nothing, and the
      // retry sends into the turn's own chat.
      const justBefore = `${site}-clicked`;
      sites.sites[site].beforeSend = () => {
        sites.sites[site].chats.set(justBefore, []);
        sites.sites[site].tab = justBefore;
      };
      a.input.push(userMessage(`${a.marker}: Continue`));
      const reply = await turn(send, a);
      assert.equal(reply.text, `answered in ${chat}`);
      assert.deepEqual(sites.sites[site].chats.get(between), []);
      assert.deepEqual(sites.sites[site].chats.get(justBefore), []);
      assert.deepEqual(sites.chatsWith(a.marker), [chat]);

      // A new chat is as safe: an existing chat shown at the moment a fresh
      // turn would send is refused, and the retry starts a new chat.
      const fresh = agent(`TAB-fresh-${site}`, site, `tab-fresh-${site}`);
      const shown = `${site}-shown`;
      sites.sites[site].beforeSend = () => {
        sites.sites[site].chats.set(shown, []);
        sites.sites[site].tab = shown;
      };
      await turn(send, fresh);
      assert.deepEqual(sites.sites[site].chats.get(shown), []);
      const freshChat = only(sites.chatsWith(fresh.marker), fresh.marker);
      assert.notEqual(freshChat, chat);
    }
  });
});

test("subagents with identical tasks and identical replies continue their own chats", async () => {
  // A tool call's id is minted per reply, so transcripts part at the first
  // call; plain replies leave nothing but the thread to tell agents apart.
  await withSites(async (send, sites) => {
    for (const site of ["chatgpt", "gemini"] as const) {
      const twins = ["a", "b", "c"].map((name) =>
        agent(
          `TWIN-${site}-${name}`,
          site,
          `twin-${site}-${name}`,
          name === "b" ? "body" : "header",
          "Summarise the module. SAME_REPLY"
        )
      );
      const firsts = await Promise.all(twins.map((t) => turn(send, t)));
      for (const first of firsts) assert.equal(first.text, "On it.");
      const chatsBefore = sites.sites[site].chats.size;
      await Promise.all(
        twins.map((t) => {
          t.input.push(userMessage(`${t.marker}: Continue`));
          return turn(send, t);
        })
      );
      assert.equal(
        sites.sites[site].chats.size,
        chatsBefore,
        "every follow-up continued a chat; none started over"
      );
      const used = twins.map((t) => only(sites.chatsWith(t.marker), t.marker));
      assert.equal(new Set(used).size, twins.length);
      for (const chat of used)
        assert.equal(sites.sites[site].chats.get(chat)!.length, 2);
    }
  });
});
