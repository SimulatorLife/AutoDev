import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  geminiModelLimit,
  OpencliCommandError
} from "@simulatorlife/autodev-runtime/providers/opencli-turn";
import { type Browser, chromium } from "playwright-core";

/**
 * The ChatGPT adapter AutoDev patches: how a prompt reaches the site.
 *
 * The prompt reaches ChatGPT as an attachment, so the turn needs the page to
 * show a file input to attach it through. The page does not always keep that
 * input where the adapter looked first -- it may sit beside the composer, or
 * in the portal the attach menu opens -- and it mounts the input a moment
 * after the composer itself is there. A turn that looked once and gave up
 * died with "file input is missing" (session
 * 01a1c6a9-dc62-7a10-ac7e-a20047d5489d), and the attachment was the only
 * way the prompt could reach the site.
 *
 * The adapter is upstream code, patched in this repository
 * (patches/@jackwener__opencli@2.0.3.patch), so it is tested against the
 * installed package: the test fails when the patch and the installed adapter
 * have drifted apart.
 */

interface UploadResult {
  readonly ok: boolean;
  readonly reason?: string;
}

interface InputLookup {
  readonly ok: boolean;
  readonly reason?: string;
  readonly seen?: number;
  readonly eligible?: number;
}

const require = createRequire(
  new URL("../../runtime/package.json", import.meta.url)
);

/** The patched ChatGPT adapter, as the installed package carries it. */
async function chatgptAdapter(): Promise<{
  uploadChatGPTFiles: (
    page: unknown,
    filePaths: readonly string[]
  ) => Promise<UploadResult>;
  selectChatGPTModel: (
    page: unknown,
    model: string
  ) => Promise<{ Status: string; Model: string }>;
} | null> {
  let entry: string;
  try {
    entry = require.resolve("@jackwener/opencli");
  } catch {
    // A tree without the package installed has nothing to test.
    return null;
  }
  const file = resolve(
    dirname(entry),
    "..",
    "..",
    "clis",
    "chatgpt",
    "utils.js"
  );
  return (await import(pathToFileURL(file).href)) as {
    uploadChatGPTFiles: (
      page: unknown,
      filePaths: readonly string[]
    ) => Promise<UploadResult>;
    selectChatGPTModel: (
      page: unknown,
      model: string
    ) => Promise<{ Status: string; Model: string }>;
  };
}

/**
 * A page that answers the adapter's two questions: where the file input is,
 * and whether the attachment chip is ready.
 */
function fakePage(lookups: readonly InputLookup[]) {
  const calls = { input: 0, chip: 0 };
  let attached: readonly string[] = [];
  const page = {
    async evaluate(script: string): Promise<unknown> {
      if (script.includes("acceptsFiles")) {
        const answer = lookups[Math.min(calls.input, lookups.length - 1)];
        calls.input += 1;
        return answer;
      }
      calls.chip += 1;
      return true;
    },
    async sleep(): Promise<void> {},
    async setFileInput(paths: readonly string[]): Promise<void> {
      attached = [...paths];
    }
  };
  return {
    page,
    calls,
    attached: (): readonly string[] => attached
  };
}

function promptFile(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(resolve(tmpdir(), "autodev-opencli-upstream-"));
  const file = resolve(directory, "turn-test.md");
  writeFileSync(file, "the prompt\n");
  return {
    path: file,
    cleanup: (): void => {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("the file input is looked for again while the page is still mounting it", async () => {
  const adapter = await chatgptAdapter();
  if (adapter === null) return;
  const { uploadChatGPTFiles } = adapter;
  const file = promptFile();
  try {
    const site = fakePage([
      { ok: false, reason: "file input is missing", seen: 1, eligible: 0 },
      { ok: false, reason: "file input is missing", seen: 1, eligible: 0 },
      { ok: true }
    ]);
    const result = await uploadChatGPTFiles(site.page, [file.path]);
    assert.equal(result.ok, true);
    assert.equal(
      site.calls.input,
      3,
      "the page was asked again while it was still rendering"
    );
    assert.deepEqual(
      [...site.attached()],
      [file.path],
      "the prompt was attached through the input the page showed"
    );
  } finally {
    file.cleanup();
  }
});

test("a page that never shows a file input says what it saw", async () => {
  const adapter = await chatgptAdapter();
  if (adapter === null) return;
  const { uploadChatGPTFiles } = adapter;
  const file = promptFile();
  try {
    const site = fakePage([
      { ok: false, reason: "file input is missing", seen: 2, eligible: 0 }
    ]);
    const result = await uploadChatGPTFiles(site.page, [file.path]);
    assert.equal(result.ok, false);
    assert.match(
      result.reason ?? "",
      /file input is missing \(0 of 2 file input\(s\) on the page accept this file\)/u
    );
    assert.ok(
      site.calls.input > 1,
      "the page was given time to mount its file input"
    );
  } finally {
    file.cleanup();
  }
});

test("inputs that all refuse the file are not waited on like a page still rendering", async () => {
  // ChatGPT stops taking uploads once an account's allowance is spent: its
  // file inputs are all there and none takes the file. Waiting does not bring
  // one back, and every second waited holds the site's only tab.
  const adapter = await chatgptAdapter();
  if (adapter === null) return;
  const { uploadChatGPTFiles } = adapter;
  const file = promptFile();
  try {
    const refusing = fakePage([
      { ok: false, reason: "file input is missing", seen: 4, eligible: 0 }
    ]);
    const refused = await uploadChatGPTFiles(refusing.page, [file.path]);
    assert.equal(refused.ok, false);
    assert.match(refused.reason ?? "", /0 of 4 file input\(s\)/u);
    assert.equal(refusing.calls.input, 3);

    // A page that shows no file input at all is given its whole wait.
    const empty = fakePage([
      { ok: false, reason: "file input is missing", seen: 0, eligible: 0 }
    ]);
    assert.equal((await uploadChatGPTFiles(empty.page, [file.path])).ok, false);
    assert.equal(empty.calls.input, 9);
  } finally {
    file.cleanup();
  }
});

/**
 * A page whose tab is not the visible one: the browser can read it, but it
 * cannot click it.
 */
function fakeBackgroundTab(before: string, after: string) {
  const calls = { nativeClick: 0, api: 0 };
  let model = before;
  const page = {
    async evaluate(script: string): Promise<unknown> {
      if (script.includes("ambiguousReasoning"))
        return { model, label: model, ambiguousReasoning: false };
      if (script.includes("hasComposer"))
        return { hasComposer: true, isLoggedIn: true, hasLoginGate: false };
      if (script.includes("aria-expanded"))
        return { found: true, open: false, x: 10, y: 10 };
      if (script.includes("oai-last-model-config")) {
        // The site's own settings API was told the level.
        model = after;
        return true;
      }
      if (script.includes("window.location.href"))
        return "https://chatgpt.com/c/6af38b5e-0900-83e9-b45a-b06db95875e1";
      return true;
    },
    async nativeClick(): Promise<void> {
      calls.nativeClick += 1;
      throw new Error(
        "Native input requires a visible browser page; input was not dispatched."
      );
    },
    async nativeKeyPress(): Promise<void> {
      throw new Error(
        "Native input requires a visible browser page; input was not dispatched."
      );
    },
    async getCookies(): Promise<
      Array<{ name: string; value: string; domain: string }>
    > {
      return [
        {
          name: "__Secure-next-auth.session-token",
          value: "session-token",
          domain: "chatgpt.com"
        }
      ];
    },
    async goto(): Promise<void> {},
    async wait(): Promise<void> {},
    async sleep(): Promise<void> {}
  };
  return { page, calls };
}

test("the model is switched through the site's own API when the picker cannot be clicked", async () => {
  const adapter = await chatgptAdapter();
  if (adapter === null) return;
  const { selectChatGPTModel } = adapter;
  const site = fakeBackgroundTab("balanced", "advanced");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/auth/session"))
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: "access-token" })
      };
    site.calls.api += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true })
    };
  }) as typeof globalThis.fetch;
  try {
    const result = await selectChatGPTModel(site.page, "advanced");
    assert.equal(result.Status, "Success");
    assert.equal(
      site.calls.nativeClick,
      1,
      "the picker was tried before the site's own API"
    );
    assert.equal(
      site.calls.api,
      1,
      "the level was set through the site's settings API"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * The Gemini adapter AutoDev patches: how a thinking level reaches the site.
 *
 * The site renamed its levels: it offered `standard` and `extended` when
 * opencli was written, and offers `low`, `medium` and `high` now. A level
 * the CLI cannot name is a level it cannot select, and `--thinking` with a
 * name the site does not use fails before the prompt is ever sent.
 *
 * The adapter is upstream code, patched in this repository
 * (patches/@jackwener__opencli@2.0.3.patch), so it is tested against the
 * installed package: the test fails when the patch and the installed adapter
 * have drifted apart.
 */
async function geminiAdapter(): Promise<{
  selectGeminiThinking: (
    page: unknown,
    thinkingValue: string
  ) => Promise<string>;
  pickerScript: () => string;
} | null> {
  let entry: string;
  try {
    entry = require.resolve("@jackwener/opencli");
  } catch {
    // A tree without the package installed has nothing to test.
    return null;
  }
  const file = resolve(
    dirname(entry),
    "..",
    "..",
    "clis",
    "gemini",
    "utils.js"
  );
  const adapter = (await import(pathToFileURL(file).href)) as {
    selectGeminiThinking: (
      page: unknown,
      thinkingValue: string
    ) => Promise<string>;
    __test__: { openModelPickerForThinkingScript: () => string };
  };
  return {
    selectGeminiThinking: adapter.selectGeminiThinking,
    pickerScript: () => adapter.__test__.openModelPickerForThinkingScript()
  };
}

/**
 * A page whose thinking submenu takes a moment to expand.
 *
 * The items of the submenu are in the DOM before it has expanded, and an
 * item with no size cannot be clicked: the adapter has to wait for the level
 * to be visible, not for a fixed half second.
 */
function fakeThinkingPage(options: {
  readonly matched: string;
  readonly hiddenProbes?: number;
}) {
  const calls = { probe: 0, selection: 0 };
  const hidden = options.hiddenProbes ?? 0;
  const page = {
    async evaluate(script: string): Promise<unknown> {
      if (script.includes("window.location.href"))
        return "https://gemini.google.com/app/1";
      if (script.includes("findModelPicker")) return { ok: true };
      if (script.includes("thinkingToggle")) return true;
      if (script.includes("candidatePatterns")) {
        calls.selection += 1;
        return options.matched;
      }
      calls.probe += 1;
      return calls.probe > hidden;
    },
    async goto(): Promise<void> {},
    async wait(): Promise<void> {},
    async sleep(): Promise<void> {}
  };
  return { page, calls };
}

test("the thinking levels the site offers can be selected", async () => {
  const adapter = await geminiAdapter();
  if (adapter === null) return;
  const { selectGeminiThinking } = adapter;
  for (const level of ["low", "medium", "high"]) {
    const site = fakeThinkingPage({ matched: `${level} Extra thorough` });
    const matched = await selectGeminiThinking(site.page, level);
    assert.equal(matched, `${level} Extra thorough`);
    assert.equal(site.calls.selection, 1);
  }
});

test("the level is waited for while the thinking submenu is still expanding", async () => {
  const adapter = await geminiAdapter();
  if (adapter === null) return;
  const { selectGeminiThinking } = adapter;
  const site = fakeThinkingPage({
    matched: "High Extra thorough",
    hiddenProbes: 3
  });
  const matched = await selectGeminiThinking(site.page, "high");
  assert.equal(matched, "High Extra thorough");
  assert.ok(
    site.calls.probe > 1,
    "the adapter looked again while the submenu was still empty"
  );
});

test("the picker is looked for where the site keeps it", async () => {
  // The site labels the composer's picker "Open mode picker, currently
  // <model>" and shows the model without a version ("Flash-Lite High"), so
  // none of the adapter's name patterns matched it: the picker was never
  // found, no menu ever opened, and every listing came back empty. The
  // model's own discovery failed with it, and a turn that asked for a model
  // or a thinking level ran at the model's the site already had.
  const adapter = await geminiAdapter();
  if (adapter === null) return;
  const script = adapter.pickerScript();
  assert.match(
    script,
    /model-picker-container/u,
    "the adapter looks for the composer's own picker"
  );
  assert.match(
    script,
    /Open mode picker/u,
    "the adapter recognises the label the site gives the picker"
  );
  assert.match(
    script,
    /mode\[\\s-\]\*picker/u,
    "the adapter's own name patterns cover the site's label"
  );
});

/** One of the installed Gemini adapter's modules, or null without the package. */
async function geminiModule<T>(file: string): Promise<T | null> {
  let entry: string;
  try {
    entry = require.resolve("@jackwener/opencli");
  } catch {
    return null;
  }
  const url = pathToFileURL(
    resolve(dirname(entry), "..", "..", "clis", "gemini", file)
  ).href;
  return (await import(url)) as T;
}

interface GeminiModelIdentity {
  geminiModelIdOf: (text: string) => string;
  geminiModelEntry: (
    item: unknown
  ) => { model: string; limit: string | null } | null;
}

/**
 * The adapter's model identity, run against picker items made of text parts.
 *
 * Each part stands for one element of the item that holds text of its own,
 * the way the page's tree walker reads it.
 */
function geminiModelIdentity(logic: string): GeminiModelIdentity {
  interface FakeItem {
    readonly parts: readonly string[];
  }
  const document = {
    createTreeWalker(root: FakeItem) {
      const nodes = root.parts.map((text) => ({
        nodeValue: text,
        parentElement: { closest: () => null }
      }));
      let index = -1;
      return { nextNode: () => nodes[++index] ?? null };
    }
  };
  // The adapter ships this logic as page-script source.
  const build = new Function(
    "document",
    "NodeFilter",
    `${logic}; return { geminiModelIdOf, geminiModelEntry };`
  ) as (document: unknown, nodeFilter: unknown) => GeminiModelIdentity;
  return build(document, { SHOW_TEXT: 4 });
}

test("a Gemini model's id is its own name, whatever the site writes beside it", async () => {
  // The picker shows each model's name and version in one part and a
  // description in another, and the site rewords the description, moves it
  // before or after the name, and replaces it with "Limit resets ..." while
  // the account is out of usage. An id read from the item's whole text was
  // `4-argon-complex-tasks`, then `code--analysis-4-argon`, then
  // `4-argon-limit-resets-nov-9-926-pm`, and every route that named the
  // model was told it did not exist.
  const utils = await geminiModule<{ geminiModelIdentityLogic: () => string }>(
    "utils.js"
  );
  if (utils === null) return;
  const { geminiModelEntry, geminiModelIdOf } = geminiModelIdentity(
    utils.geminiModelIdentityLogic()
  );
  const item = (...parts: string[]) => geminiModelEntry({ parts });

  assert.deepEqual(item("Quick answers", "3.5 Flash-Lite"), {
    model: "3.5-flash-lite",
    limit: null
  });
  assert.deepEqual(item("All-around help", "3.8 Flash"), {
    model: "3.8-flash",
    limit: null
  });
  assert.deepEqual(item("Detailed research", "3.1 Pro"), {
    model: "3.1-pro",
    limit: null
  });
  assert.deepEqual(item("Code & analysis", "4 Argon"), {
    model: "4-argon",
    limit: null
  });
  assert.deepEqual(item("4 Carbon", "Most complex work"), {
    model: "4-carbon",
    limit: null
  });
  // Out of usage, the model keeps its id and says when it comes back.
  assert.deepEqual(item("Limit resets Nov 9, 9:26 PM", "4 Argon"), {
    model: "4-argon",
    limit: "Limit resets Nov 9, 9:26 PM"
  });
  // The thinking levels share the menu and are no model.
  assert.equal(item("Low", "Fast and efficient"), null);
  assert.equal(geminiModelIdOf("Gemini 3.1 Pro"), "3.1-pro");
  assert.equal(geminiModelIdOf("Code & analysis"), "");
});

test("a Gemini model that is out of usage is refused as its usage limit", async () => {
  // `gemini ask --model` on a model the account is out of usage on fails
  // under its own code with the site's text, and the bridge reads that back
  // as the limit with the instant the site named -- not as a model that does
  // not exist.
  const ask = await geminiModule<{
    __test__: {
      geminiModelLimitError: (
        model: string,
        limit: string
      ) => Error & { code: string; hint?: string; exitCode: number };
    };
  }>("ask.js");
  if (ask === null) return;
  const refusal = ask.__test__.geminiModelLimitError(
    "4-argon",
    "Limit resets Nov 9, 9:26 PM"
  );
  assert.equal(refusal.code, "MODEL_LIMIT");
  const limit = geminiModelLimit(
    new OpencliCommandError(
      `${refusal.message} (${refusal.hint ?? ""})`,
      refusal.code,
      refusal.exitCode
    ),
    new Date(2026, 10, 9, 12, 0).getTime()
  );
  assert.equal(
    limit?.message,
    `Gemini usage limit reached for 4-argon; resets at ${new Date(2026, 10, 9, 21, 26).toISOString()}`
  );
});

interface GeminiPageUtils {
  geminiAppUrl: (path?: string) => string;
  isGeminiAppPath: (pathname: string) => boolean;
  ensureGeminiPage: (page: unknown) => Promise<void>;
}

/** Run `body` with OPENCLI_GEMINI_ACCOUNT set to `account` (or unset). */
async function withGeminiAccount<T>(
  account: string | null,
  body: () => Promise<T>
): Promise<T> {
  const previous = process.env.OPENCLI_GEMINI_ACCOUNT;
  if (account === null) delete process.env.OPENCLI_GEMINI_ACCOUNT;
  else process.env.OPENCLI_GEMINI_ACCOUNT = account;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.OPENCLI_GEMINI_ACCOUNT;
    else process.env.OPENCLI_GEMINI_ACCOUNT = previous;
  }
}

/**
 * A Gemini tab that always shows `url` signed in as `email`: the landing page
 * an account without the Gemini app is redirected to, whatever is opened.
 */
function geminiTab(url: string, email: string | null) {
  const visited: string[] = [];
  return {
    visited,
    page: {
      evaluate: (script: string) => {
        if (script === "window.location.href") return Promise.resolve(url);
        if (script.includes("SignOutOptions"))
          return Promise.resolve(
            email === null ? { kind: "auth" } : { ok: true, name: "", email }
          );
        // The unusual-traffic probe: the page is not blocked.
        return Promise.resolve(false);
      },
      goto: (target: string) => {
        visited.push(target);
        return Promise.resolve();
      },
      wait: () => Promise.resolve()
    }
  };
}

test("the Gemini app is opened as the configured Google account", async () => {
  // A browser signed in to several Google accounts opens gemini.google.com/app
  // as its first one. When that is a Workspace account without the Gemini app,
  // the site shows its landing page -- no composer, no model picker -- and
  // every listing failed as "model picker button was not found", which left
  // the provider's model choices disabled in the Console.
  const utils = await geminiModule<GeminiPageUtils>("utils.js");
  if (utils === null) return;
  await withGeminiAccount(null, async () => {
    assert.equal(utils.geminiAppUrl(), "https://gemini.google.com/app");
  });
  await withGeminiAccount("someone@example.com", async () => {
    assert.equal(
      utils.geminiAppUrl(),
      "https://gemini.google.com/app?authuser=someone%40example.com"
    );
    assert.equal(
      utils.geminiAppUrl("/abc123"),
      "https://gemini.google.com/app/abc123?authuser=someone%40example.com"
    );
  });
  assert.equal(utils.isGeminiAppPath("/app"), true);
  assert.equal(utils.isGeminiAppPath("/u/1/app/abc123"), true);
  assert.equal(utils.isGeminiAppPath("/u/0/"), false);
  assert.equal(utils.isGeminiAppPath("/"), false);
});

test("a Gemini tab that shows the landing page is a sign-in to fix, not a changed picker", async () => {
  const utils = await geminiModule<GeminiPageUtils>("utils.js");
  if (utils === null) return;
  const tab = geminiTab("https://gemini.google.com/u/0/", "work@example.com");
  const failure = await withGeminiAccount(null, () =>
    utils.ensureGeminiPage(tab.page).then(
      () => null,
      (error: unknown) => error as Error & { code?: string }
    )
  );
  assert.ok(failure, "the landing page is refused");
  assert.equal(failure.code, "AUTH_REQUIRED");
  assert.match(failure.message, /work@example\.com/u);
  assert.match(failure.message, /OPENCLI_GEMINI_ACCOUNT/u);
  assert.deepEqual(tab.visited, ["https://gemini.google.com/app"]);
});

test("a Gemini tab signed in as another account is reopened as the configured one", async () => {
  const utils = await geminiModule<GeminiPageUtils>("utils.js");
  if (utils === null) return;
  const tab = geminiTab("https://gemini.google.com/app", "work@example.com");
  const failure = await withGeminiAccount("someone@example.com", () =>
    utils.ensureGeminiPage(tab.page).then(
      () => null,
      (error: unknown) => error as Error & { code?: string }
    )
  );
  assert.deepEqual(tab.visited, [
    "https://gemini.google.com/app?authuser=someone%40example.com"
  ]);
  // The browser is not signed in to the configured account, so the tab still
  // shows the other one: that is a sign-in for the operator to make.
  assert.equal(failure?.code, "AUTH_REQUIRED");
  assert.match(failure?.message ?? "", /someone@example\.com/u);
});

interface GeminiSnapshot {
  readonly url: string;
  readonly turns: readonly { Role: string; Text: string }[];
  readonly transcriptLines: readonly string[];
  readonly composerHasText: boolean;
  readonly isGenerating: boolean;
  readonly structuredTurnsTrusted: boolean;
}

interface GeminiReplyUtils {
  waitForGeminiResponse: (
    page: unknown,
    baseline: {
      snapshot: GeminiSnapshot;
      userAnchorTurn: { Role: string; Text: string } | null;
    },
    promptText: string,
    timeoutSeconds: number
  ) => Promise<string>;
  waitForGeminiSubmission: (
    page: unknown,
    before: GeminiSnapshot,
    timeoutSeconds: number
  ) => Promise<{ reason: string } | null>;
  __test__: { readGeminiSnapshotScript: () => string };
}

const GEMINI_CHAT_URL = "https://gemini.google.com/app/c1f94246f36a5126";
const GEMINI_PROMPT = "# Codex agent turn\n\nReview the codebase.";
/** What Gemini's side navigation reads as, one line per entry. */
const GEMINI_SIDEBAR_LINES = [
  "Library",
  "Images",
  "OpenCLI Provider Optimization Delegation",
  "# Codex agent turn"
];

/** A Gemini tab whose snapshot reads, poll by poll, as `snapshots`. */
function geminiChat(snapshots: readonly GeminiSnapshot[]) {
  let polls = 0;
  return {
    polls: (): number => polls,
    page: {
      evaluate: (script: string) => {
        if (script === "window.location.href")
          return Promise.resolve(GEMINI_CHAT_URL);
        const snapshot = snapshots[Math.min(polls, snapshots.length - 1)];
        polls += 1;
        return Promise.resolve(snapshot);
      },
      wait: () => Promise.resolve()
    }
  };
}

function geminiSnapshot(
  turns: GeminiSnapshot["turns"],
  transcriptLines: readonly string[]
): GeminiSnapshot {
  return {
    url: GEMINI_CHAT_URL,
    turns,
    transcriptLines,
    composerHasText: false,
    isGenerating: false,
    structuredTurnsTrusted: true
  };
}

test("a Gemini reply still coming is waited for, not read from the page around it", async () => {
  // A long prompt keeps Gemini quiet for a while after its turn shows. The
  // adapter took two quiet polls as a sign the chat had no structured layout
  // and read the reply from the page's transcript instead -- the side
  // navigation's menu and chat titles. Session
  // 01a1d23e-d01e-77b1-a353-70e46311cda7 ended its root turn on "Gemini New
  // chatLibraryImages...# Codex agent turn" while Gemini's actual reply, a
  // tool call, sat in the chat unread.
  const utils = await geminiModule<GeminiReplyUtils>("utils.js");
  if (utils === null) return;
  const user = { Role: "User", Text: GEMINI_PROMPT };
  const reply = '<tool_call name="exec">\ntext("ok")\n</tool_call>';
  const asked = geminiSnapshot([user], [GEMINI_PROMPT]);
  const thinking = geminiSnapshot(
    [user],
    [GEMINI_PROMPT, ...GEMINI_SIDEBAR_LINES]
  );
  const answered = geminiSnapshot(
    [user, { Role: "Assistant", Text: reply }],
    [GEMINI_PROMPT, ...GEMINI_SIDEBAR_LINES, reply]
  );
  const chat = geminiChat([
    thinking,
    thinking,
    thinking,
    thinking,
    thinking,
    answered,
    answered
  ]);
  const response = await utils.waitForGeminiResponse(
    chat.page,
    { snapshot: asked, userAnchorTurn: user },
    GEMINI_PROMPT,
    60
  );
  assert.equal(response, reply);
});

test("a Gemini reply being written is reported on the progress descriptor, not on the result", async () => {
  // The bridge shows prose as it is written. Each new reading of the reply
  // while Gemini is still generating is one JSON line on the descriptor
  // OPENCLI_PROGRESS_FD names; the result stays the finished reply alone.
  const utils = await geminiModule<GeminiReplyUtils>("utils.js");
  if (utils === null) return;
  const user = { Role: "User", Text: GEMINI_PROMPT };
  const asked = geminiSnapshot([user], [GEMINI_PROMPT]);
  const writing = (text: string): GeminiSnapshot => ({
    ...geminiSnapshot([user, { Role: "Assistant", Text: text }], []),
    isGenerating: true
  });
  const done = geminiSnapshot(
    [user, { Role: "Assistant", Text: "First line.\nSecond line." }],
    []
  );
  const chat = geminiChat([
    geminiSnapshot([user], []),
    writing("First"),
    writing("First"),
    writing("First line.\nSec"),
    done,
    done
  ]);
  const directory = mkdtempSync(resolve(tmpdir(), "autodev-opencli-progress-"));
  const file = resolve(directory, "progress");
  const fd = openSync(file, "w");
  const saved = process.env.OPENCLI_PROGRESS_FD;
  process.env.OPENCLI_PROGRESS_FD = String(fd);
  try {
    const response = await utils.waitForGeminiResponse(
      chat.page,
      { snapshot: asked, userAnchorTurn: user },
      GEMINI_PROMPT,
      60
    );
    assert.equal(response, "First line.\nSecond line.");
  } finally {
    if (saved === undefined) delete process.env.OPENCLI_PROGRESS_FD;
    else process.env.OPENCLI_PROGRESS_FD = saved;
    closeSync(fd);
  }
  const lines = readFileSync(file, "utf8").trim().split("\n");
  rmSync(directory, { recursive: true, force: true });
  // A reading is reported once, when it changes; the finished reply is the
  // result, not progress.
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as { text: string }).text),
    ["First", "First line.\nSec"]
  );
  assert.equal(
    (JSON.parse(lines[0] ?? "{}") as { url: string }).url,
    GEMINI_CHAT_URL
  );
});

test("a Gemini reply is not reported when no progress descriptor is named", async () => {
  const utils = await geminiModule<GeminiReplyUtils>("utils.js");
  if (utils === null) return;
  const user = { Role: "User", Text: GEMINI_PROMPT };
  const writing: GeminiSnapshot = {
    ...geminiSnapshot([user, { Role: "Assistant", Text: "Part" }], []),
    isGenerating: true
  };
  const done = geminiSnapshot([user, { Role: "Assistant", Text: "Whole" }], []);
  const saved = process.env.OPENCLI_PROGRESS_FD;
  delete process.env.OPENCLI_PROGRESS_FD;
  try {
    const response = await utils.waitForGeminiResponse(
      geminiChat([writing, done, done]).page,
      { snapshot: geminiSnapshot([user], []), userAnchorTurn: user },
      GEMINI_PROMPT,
      60
    );
    assert.equal(response, "Whole");
  } finally {
    if (saved !== undefined) process.env.OPENCLI_PROGRESS_FD = saved;
  }
});

test("a Gemini chat's changing sidebar is not taken for the prompt being sent", async () => {
  // A new chat appears in the sidebar under its prompt's first words before
  // the chat shows the prompt's turn. On a page with the structured layout
  // only that turn says the prompt was taken.
  const utils = await geminiModule<GeminiReplyUtils>("utils.js");
  if (utils === null) return;
  const before = geminiSnapshot(
    [{ Role: "User", Text: "an earlier prompt" }],
    ["an earlier prompt"]
  );
  const titled = geminiSnapshot(before.turns, [
    "an earlier prompt",
    ...GEMINI_SIDEBAR_LINES
  ]);
  const user = { Role: "User", Text: GEMINI_PROMPT };
  const sent = geminiSnapshot(
    [...before.turns, user],
    ["an earlier prompt", ...GEMINI_SIDEBAR_LINES, GEMINI_PROMPT]
  );
  const chat = geminiChat([titled, titled, sent]);
  const submitted = await utils.waitForGeminiSubmission(chat.page, before, 10);
  assert.equal(submitted?.reason, "user_turn");
  assert.equal(chat.polls(), 3);
});

/** Headless Chromium, or null on a machine without playwright-core's browser. */
async function headlessChromium(): Promise<Browser | null> {
  if (!existsSync(chromium.executablePath())) return null;
  return chromium.launch({ headless: true });
}

test("a Gemini transcript is read from the chat, never from the sidebar beside it", async () => {
  // Gemini's <main> holds the side navigation as well as the chat. The
  // transcript was read from all of <main>, and from a detached copy, whose
  // innerText is its textContent: the sidebar came back as one glued line.
  const utils = await geminiModule<GeminiReplyUtils>("utils.js");
  if (utils === null) return;
  // A tree without a Chromium for playwright-core has no page to read.
  const browser = await headlessChromium();
  if (browser === null) return;
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body><chat-app><main>
      <bard-sidenav><side-navigation-v2>
        <span>Gemini</span><a>New chat</a><a>Library</a><a>Images</a>
        <conversations-list>
          <a href="/app/1">OpenCLI Provider Optimization Delegation</a>
          <a href="/app/2"># Codex agent turn</a>
        </conversations-list>
      </side-navigation-v2></bard-sidenav>
      <chat-window><div class="conversation-container">
        <user-query><div class="query-text">
          <p class="query-text-line"># Codex agent turn</p>
          <p class="query-text-line">Review the codebase.</p>
        </div></user-query>
        <model-response><div class="model-response-text"></div></model-response>
      </div></chat-window>
    </main></chat-app></body></html>`);
    const snapshot = (await page.evaluate(
      utils.__test__.readGeminiSnapshotScript()
    )) as GeminiSnapshot;
    assert.deepEqual(snapshot.turns, [
      { Role: "User", Text: "# Codex agent turn\nReview the codebase." }
    ]);
    assert.deepEqual(snapshot.transcriptLines, [
      "# Codex agent turn",
      "Review the codebase."
    ]);
  } finally {
    await browser.close();
  }
});

/** The ChatGPT reply reader, as the installed package carries it. */
interface ChatGPTReplyUtils {
  waitForChatGPTResponse: (
    page: unknown,
    baselineCount: number,
    prompt: string,
    timeoutSeconds: number,
    options: {
      baselinePairCounts: Map<string, number>;
      expectedConversationId?: string;
      baselinePromptId?: string | null;
    }
  ) => Promise<string>;
  getChatGPTStoredPromptId: (page: unknown) => Promise<string | null>;
  chatgptReplyFromConversation: (
    conversation: unknown
  ) => {
    text: string;
    finished: boolean;
    promptText: string;
    promptId: string;
  } | null;
  chatgptReplyCanFinish: (
    stored: { text: string; finished: boolean },
    stableMs: number,
    isGeneratingNow: boolean
  ) => boolean;
}

async function chatgptReplyUtils(): Promise<ChatGPTReplyUtils | null> {
  const adapter = (await chatgptAdapter()) as unknown;
  return adapter as ChatGPTReplyUtils | null;
}

const CHATGPT_CHAT_ID = "6afb4b8e-1520-83ea-9e27-4a42da8e7425";
const CHATGPT_PROMPT =
  "Read the attached file turn-54834ad80013.md and respond exactly as it instructs.";
/** What ChatGPT stored as the worker's reply in session 01a1e592-6349-73a2-8d2f-3d8bea217417. */
const CHATGPT_STORED_REPLY =
  '<tool_call name="exec">\nconst names = ALL_TOOLS.filter(x => /exec_command/i.test(x.name)).map(x => ({name:x.name})); text(names);\n</tool_call>';
/** What the page showed of it: the tags gone, the script cut at its first `{`. */
const CHATGPT_SHOWN_REPLY =
  "const names = ALL_TOOLS.filter(x => /exec_command/i.test(x.name)).map(x => (";

/**
 * A stored conversation shaped like ChatGPT's: the turn's messages hang off
 * one another by `parent`, and the mapping's key order is not their order.
 */
function storedConversation(
  finalEndTurn: boolean | null,
  replyText = CHATGPT_STORED_REPLY,
  promptText = CHATGPT_PROMPT,
  promptId = "prompt"
): unknown {
  const message = (
    role: string,
    contentType: string,
    parts: unknown,
    extra: Record<string, unknown> = {}
  ) => ({
    author: { role },
    recipient: "all",
    content: { content_type: contentType, parts },
    ...extra
  });
  const nodes: [string, string | null, unknown][] = [
    ["root", null, null],
    ["system", "root", message("system", "text", [""])],
    [promptId, "system", message("user", "text", [promptText])],
    [
      "read",
      promptId,
      message("tool", "multimodal_text", ["# Codex agent turn"])
    ],
    [
      "thoughts",
      "read",
      {
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "thoughts", thoughts: [] }
      }
    ],
    [
      "reply",
      "thoughts",
      message("assistant", "text", [replyText], {
        end_turn: finalEndTurn
      })
    ],
    // An earlier branch of the chat, off the current one.
    [
      "edited",
      "system",
      message("assistant", "text", ["an abandoned reply"], { end_turn: true })
    ]
  ];
  const mapping: Record<string, unknown> = {};
  for (const [id, parent, value] of [...nodes].reverse())
    mapping[id] = { id, parent, message: value };
  return { current_node: "reply", mapping };
}

/**
 * A ChatGPT tab that shows `shown` as the reply and stores `stored`.
 * The stored reply is read by running the adapter's own page script against
 * a fetch that serves the session and the conversation.
 */
function chatgptChat(
  shown: string,
  stored: () => Response,
  generating: () => boolean = () => false,
  currentUrl: () => string = () => `https://chatgpt.com/c/${CHATGPT_CHAT_ID}`
) {
  const fetched: string[] = [];
  const fetch = (url: string, init?: { headers?: Record<string, string> }) => {
    fetched.push(url);
    if (url === "/api/auth/session")
      return Promise.resolve(Response.json({ accessToken: "token" }));
    assert.equal(init?.headers?.authorization, "Bearer token");
    return Promise.resolve(stored());
  };
  return {
    fetched,
    page: {
      sleep: () => Promise.resolve(),
      evaluate: (script: string): Promise<unknown> => {
        if (script === "window.location.href")
          return Promise.resolve(currentUrl());
        if (script.includes("/backend-api/conversation/"))
          return (
            new Function("fetch", `return ${script.trim()}`) as (
              fetch: unknown
            ) => Promise<unknown>
          )(fetch);
        if (script.includes("stop-button")) return Promise.resolve(generating());
        return Promise.resolve([
          { role: "User", text: CHATGPT_PROMPT, html: "" },
          { role: "Assistant", text: shown, html: "" }
        ]);
      }
    }
  };
}

test("a ChatGPT reply is the one the site stored, not the page's rendering of it", async () => {
  // The page drops what looks like an HTML tag and can stop partway: the
  // worker in session 01a1e592-6349-73a2-8d2f-3d8bea217417 wrote a full
  // <tool_call>, the page showed a tagless script cut at its first `{`, and
  // that fragment ended the worker's turn as its answer.
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  const chat = chatgptChat(CHATGPT_SHOWN_REPLY, () =>
    Response.json(storedConversation(true))
  );
  const reply = await utils.waitForChatGPTResponse(
    chat.page,
    0,
    CHATGPT_PROMPT,
    30,
    { baselinePairCounts: new Map() }
  );
  assert.equal(reply, CHATGPT_STORED_REPLY);
  assert.deepEqual(chat.fetched, [
    "/api/auth/session",
    `/backend-api/conversation/${CHATGPT_CHAT_ID}`
  ]);
});

test("a ChatGPT reply whose stored text cannot be read fails instead of using the page's", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  const chat = chatgptChat(
    CHATGPT_SHOWN_REPLY,
    () => new Response("{}", { status: 404 })
  );
  await assert.rejects(
    utils.waitForChatGPTResponse(chat.page, 0, CHATGPT_PROMPT, 1, {
      baselinePairCounts: new Map()
    }),
    /stored text could not be read: conversation fetch status 404/u
  );
});

test("a stored ChatGPT turn is read along its current branch and ends only when the site says so", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  assert.deepEqual(
    utils.chatgptReplyFromConversation(storedConversation(true)),
    {
      text: CHATGPT_STORED_REPLY,
      finished: true,
      promptText: CHATGPT_PROMPT,
      promptId: "prompt"
    }
  );
  assert.deepEqual(
    utils.chatgptReplyFromConversation(storedConversation(false)),
    { text: CHATGPT_STORED_REPLY, finished: false, promptText: CHATGPT_PROMPT, promptId: "prompt" }
  );
  assert.equal(
    utils.chatgptReplyFromConversation({ current_node: null, mapping: {} }),
    null
  );
});

test("ChatGPT's missing completion marker requires a settled reply and stopped generation", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  const stored = { text: "Done-looking reply", finished: false };
  assert.equal(utils.chatgptReplyCanFinish(stored, 11_999, false), false);
  assert.equal(utils.chatgptReplyCanFinish(stored, 12_000, true), false);
  assert.equal(utils.chatgptReplyCanFinish(stored, 12_000, false), true);
  assert.equal(
    utils.chatgptReplyCanFinish({ ...stored, finished: true }, 0, true),
    true
  );
});

test("ChatGPT stored reply progress is written on fd 3, separate from stdout/stderr", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  const directory = mkdtempSync(resolve(tmpdir(), "autodev-chatgpt-progress-"));
  const file = resolve(directory, "progress");
  const fd = openSync(file, "w");
  const saved = process.env.OPENCLI_PROGRESS_FD;
  let storedReads = 0;
  process.env.OPENCLI_PROGRESS_FD = String(fd);
  try {
    const chat = chatgptChat(CHATGPT_SHOWN_REPLY, () =>
      Response.json(storedConversation(++storedReads > 2))
    );
    const reply = await utils.waitForChatGPTResponse(
      chat.page,
      0,
      CHATGPT_PROMPT,
      30,
      { baselinePairCounts: new Map() }
    );
    assert.equal(reply, CHATGPT_STORED_REPLY);
  } finally {
    if (saved === undefined) delete process.env.OPENCLI_PROGRESS_FD;
    else process.env.OPENCLI_PROGRESS_FD = saved;
    closeSync(fd);
  }
  const records = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { text: string; url: string });
  rmSync(directory, { recursive: true, force: true });
  assert.deepEqual(records, [
    {
      text: CHATGPT_STORED_REPLY,
      url: `https://chatgpt.com/c/${CHATGPT_CHAT_ID}`
    }
  ]);
});

test("ChatGPT publishes changing stored text while generation is still active", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  const directory = mkdtempSync(resolve(tmpdir(), "autodev-chatgpt-live-"));
  const file = resolve(directory, "progress");
  const fd = openSync(file, "w");
  const saved = process.env.OPENCLI_PROGRESS_FD;
  let reads = 0;
  let activeReads = 0;
  process.env.OPENCLI_PROGRESS_FD = String(fd);
  try {
    const chat = chatgptChat(
      "",
      () => {
        reads += 1;
        const reply =
          reads === 1
            ? "Working.\n"
            : reads === 2
              ? "Working.\nStill working.\n"
              : "Working.\nStill working.\nDone.";
        return Response.json(storedConversation(reads >= 3, reply));
      },
      () => {
        activeReads += 1;
        return true;
      }
    );
    const reply = await utils.waitForChatGPTResponse(
      chat.page,
      0,
      CHATGPT_PROMPT,
      5,
      { baselinePairCounts: new Map() }
    );
    assert.equal(reply, "Working.\nStill working.\nDone.");
    assert.ok(activeReads >= 3, "generation was active on every stored read");
    assert.equal(reads, 3, "partial records were read before end_turn");
  } finally {
    if (saved === undefined) delete process.env.OPENCLI_PROGRESS_FD;
    else process.env.OPENCLI_PROGRESS_FD = saved;
    closeSync(fd);
  }
  const records = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { text: string; url: string });
  rmSync(directory, { recursive: true, force: true });
  assert.deepEqual(records.map((record) => record.text), [
    "Working.\n",
    "Working.\nStill working.\n",
    "Working.\nStill working.\nDone."
  ]);
});


test("a repeated ChatGPT prompt waits for a new stored user node", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  let reads = 0;
  const chat = chatgptChat(
    "Repeated",
    () => {
      reads += 1;
      // The previous completed reply has exactly the same user prompt.
      return Response.json(
        reads === 1
          ? storedConversation(true, "Stale reply", CHATGPT_PROMPT, "old-prompt")
          : storedConversation(true, "New reply", CHATGPT_PROMPT, "new-prompt")
      );
    }
  );
  const reply = await utils.waitForChatGPTResponse(
    chat.page,
    0,
    CHATGPT_PROMPT,
    2,
    { baselinePairCounts: new Map(), baselinePromptId: "old-prompt" }
  );
  assert.equal(reply, "New reply");
  assert.equal(reads, 2, "the completed previous turn must be ignored");
});

test("the ChatGPT send baseline reads the last persisted user-message ID", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  const chat = chatgptChat(
    "",
    () => Response.json(storedConversation(true, "Prior answer", CHATGPT_PROMPT, "prior-user"))
  );
  assert.equal(await utils.getChatGPTStoredPromptId(chat.page), "prior-user");
});

test("ChatGPT waits 12 seconds after generation stops before accepting partial text", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  const originalNow = Date.now;
  let now = 0;
  let polls = 0;
  Date.now = () => now;
  try {
    const chat = chatgptChat(
      "",
      () => Response.json(storedConversation(polls >= 3, "Partial.")),
      () => ++polls === 1
    );
    chat.page.sleep = async () => {
      now += 20_000;
    };
    const result = await utils.waitForChatGPTResponse(
      chat.page,
      0,
      CHATGPT_PROMPT,
      180,
      { baselinePairCounts: new Map() }
    );
    assert.equal(result, "Partial.");
    assert.equal(polls, 3, "the first non-generating poll must not complete a partial reply");
  } finally {
    Date.now = originalNow;
  }
});

test("ChatGPT starts an unreadable-storage grace period only after generation stops", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  const originalNow = Date.now;
  let now = 0;
  let reads = 0;
  Date.now = () => now;
  try {
    const chat = chatgptChat(
      "",
      () => {
        reads += 1;
        return reads <= 2
          ? new Response("pending persistence", { status: 404 })
          : Response.json(storedConversation(true, "New answer."));
      },
      () => reads === 0
    );
    chat.page.sleep = async () => {
      now += 20_000;
    };
    const result = await utils.waitForChatGPTResponse(
      chat.page,
      0,
      CHATGPT_PROMPT,
      180,
      { baselinePairCounts: new Map() }
    );
    assert.equal(result, "New answer.");
    assert.equal(reads, 3);
  } finally {
    Date.now = originalNow;
  }
});

test("ChatGPT rejects a finished stored answer from another conversation", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  const otherChat = "00000000-1111-2222-3333-444444444444";
  const chat = chatgptChat(
    "Done",
    () => Response.json(storedConversation(true)),
    () => false,
    () => "https://chatgpt.com/c/" + otherChat
  );
  await assert.rejects(
    utils.waitForChatGPTResponse(chat.page, 0, CHATGPT_PROMPT, 2, {
      baselinePairCounts: new Map(),
      expectedConversationId: CHATGPT_CHAT_ID
    }),
    /navigated away from the submitted conversation/u
  );
});

test("an incomplete stored answer times out rather than becoming an unreadable-reply error", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  const chat = chatgptChat(
    "Still writing",
    () => Response.json(storedConversation(false)),
    () => true
  );
  await assert.rejects(
    utils.waitForChatGPTResponse(chat.page, 0, CHATGPT_PROMPT, 0.1, {
      baselinePairCounts: new Map()
    }),
    (error: unknown) =>
      error instanceof Error && /timed out|timeout/iu.test(error.message)
  );
});

test("the stored reply must belong to the submitted prompt", async () => {
  const utils = await chatgptReplyUtils();
  assert.ok(utils, "the patched OpenCLI adapter must be installed");
  const chat = chatgptChat(
    "Wrong reply",
    () =>
      Response.json(storedConversation(true, "Wrong reply", "A different prompt")),
    () => true
  );
  await assert.rejects(
    utils.waitForChatGPTResponse(chat.page, 0, CHATGPT_PROMPT, 0.1, {
      baselinePairCounts: new Map()
    }),
    (error: unknown) =>
      error instanceof Error && /timed out|timeout/iu.test(error.message)
  );
});

test("the pnpm lock references the exact OpenCLI patch SHA256 in all three locations", () => {
  const patch = readFileSync(
    fileURLToPath(
      new URL("../../patches/@jackwener__opencli@2.0.3.patch", import.meta.url)
    )
  );
  const lock = readFileSync(
    fileURLToPath(new URL("../../pnpm-lock.yaml", import.meta.url)),
    "utf8"
  );
  const digest = createHash("sha256").update(patch).digest("hex");
  assert.ok(
    lock.includes("'@jackwener/opencli@2.0.3': " + digest),
    "the patchedDependencies entry must match the patch bytes"
  );
  const importerHashes = [
    ...lock.matchAll(/2\.0\.3\(patch_hash=([0-9a-f]{64})\)/gu)
  ].map((match) => match[1]);
  assert.deepEqual(importerHashes, [digest, digest]);
});

test("a Gemini reply keeps the line breaks the page shows inside a paragraph", async () => {
  // Gemini's reply panel is `white-space: pre-wrap`: a tool call's script is
  // a paragraph whose line breaks show on screen. Reading it as collapsed
  // whitespace put every script of session 01a1e592-6349-73a2-8d2f-3d8bea217417
  // on one line, so `// @exec: {...}` swallowed the script after it.
  const utils = await geminiModule<GeminiReplyUtils>("utils.js");
  if (utils === null) return;
  const browser = await headlessChromium();
  if (browser === null) return;
  const script =
    '<tool_call name="exec">\n// @exec: {"yield_time_ms": 330000}\nconst r = await tools.exec_command({\n  cmd: "pnpm test:unit"\n});\ntext(r.output);\n</tool_call>';
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body><chat-window>
      <div class="conversation-container">
        <user-query><div class="query-text"><p class="query-text-line">Run the tests.</p></div></user-query>
        <model-response><div class="model-response-text"><div class="markdown" style="white-space: pre-wrap"><p></p></div></div></model-response>
      </div>
    </chat-window></body></html>`);
    await page.$eval(
      ".markdown p",
      (paragraph, text) => {
        paragraph.textContent = text;
      },
      script
    );
    const snapshot = (await page.evaluate(
      utils.__test__.readGeminiSnapshotScript()
    )) as GeminiSnapshot;
    assert.deepEqual(snapshot.turns, [
      { Role: "User", Text: "Run the tests." },
      { Role: "Assistant", Text: script }
    ]);
  } finally {
    await browser.close();
  }
});
