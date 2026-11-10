import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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
