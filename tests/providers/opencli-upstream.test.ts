import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  geminiModelLimit,
  OpencliCommandError
} from "@simulatorlife/autodev-runtime/providers/opencli-turn";

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
