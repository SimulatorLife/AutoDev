import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ControlApiPromptVersionResponse } from "@simulatorlife/autodev-core";

import { promptHistoryState } from "../src/features/prompts/history-state.ts";
import {
  historyOffsetFromQuery,
  promptVersionSelection
} from "../src/lib/server/prompt-history.ts";

/**
 * The prompt's committed history: the page a URL names, and the revision a URL
 * asks to open.
 *
 * The history is one ordered list of committed revisions and a page of it is a
 * window, so the operator who needs an older revision asks for the next page
 * instead of being told to go and read Git. The page is named in the URL, so
 * the walk is addressable.
 *
 * Which revisions exist is the Control API's answer and not the page's: a
 * revision the operator reached by paging back is older than the page the
 * page happens to be showing, and a revision URL copied from another page has
 * to keep working. So the selection policy is pinned here, where it can be
 * exercised directly rather than through a route that cannot be imported
 * outside a Next.js runtime.
 */

const COMMAND = "dry";
const NEWEST_HASH = "a".repeat(40);
const OLDER_HASH = "b".repeat(40);

function version(versionHash: string): ControlApiPromptVersionResponse {
  return {
    schema: "autodev-control-prompt-version-v1",
    name: COMMAND,
    versionHash,
    updatedAt: "2026-01-02T03:04:05Z",
    content: "# /dry\n\nUse a dry run.",
    diff: "-Use a dry run.\n+Use the current source.\n"
  };
}

test("the URL names the page of the history to read", () => {
  assert.equal(historyOffsetFromQuery(undefined), 0);
  assert.equal(historyOffsetFromQuery("20"), 20);
  assert.equal(historyOffsetFromQuery(["20"]), 20);
  // A query value that is not a whole offset of zero or more is not an
  // offset, so it is ignored rather than clamped: a clamped offset would
  // answer a page the operator did not ask for.
  assert.equal(historyOffsetFromQuery("-1"), 0);
  assert.equal(historyOffsetFromQuery("1.5"), 0);
  assert.equal(historyOffsetFromQuery("abc"), 0);
  assert.equal(historyOffsetFromQuery(""), 0);
});

test("the history the view renders carries the page it came from", () => {
  const available = promptHistoryState({
    schema: "autodev-control-prompt-versions-v2",
    name: COMMAND,
    status: "available",
    versions: [{ versionHash: NEWEST_HASH, updatedAt: "2026-01-02T03:04:05Z" }],
    hasMore: true,
    offset: 20,
    limit: 20
  });
  assert.equal(available.status, "available");
  assert.equal(available.offset, 20);
  assert.equal(available.limit, 20);
  assert.equal(available.hasMore, true);

  const unavailable = promptHistoryState(null);
  assert.equal(unavailable.status, "unavailable");
});

test("a revision from an older page opens, because the list is not what decides", () => {
  const selection = promptVersionSelection(COMMAND, OLDER_HASH, {
    kind: "ok",
    data: version(OLDER_HASH)
  });
  assert.equal(selection.selectedVersion?.versionHash, OLDER_HASH);
  assert.equal(selection.error, undefined);
});

test("a revision no commit ever made is refused, and says so", () => {
  const selection = promptVersionSelection(COMMAND, OLDER_HASH, {
    kind: "http-error",
    status: 404,
    code: "autodev_control_api_unknown_prompt_version",
    message: "Unknown committed prompt version."
  });
  assert.equal(selection.selectedVersion, undefined);
  assert.equal(
    selection.error,
    "That revision is not a committed version of this command."
  );
});

test("a history the service could not read is not blamed on the revision", () => {
  const selection = promptVersionSelection(COMMAND, OLDER_HASH, {
    kind: "http-error",
    status: 503,
    code: "autodev_control_api_prompt_history_unavailable",
    message: "Committed prompt history is unavailable for this source."
  });
  assert.equal(selection.selectedVersion, undefined);
  assert.equal(
    selection.error,
    "The selected committed version could not be loaded; the current source is unchanged."
  );
});

test("a URL that names no revision asks for none", () => {
  assert.deepEqual(promptVersionSelection(COMMAND, undefined, null), {});
});

test("the route reads the page the URL names and asks for it", () => {
  // The route is the seam between the URL and the Control API, and it cannot
  // be imported outside a Next.js runtime, so what it passes on is pinned by
  // reading it: the offset the URL names has to reach the read, or the pager
  // would render a page the operator never asked for.
  const source = readFileSync(
    new URL("../app/prompts/[name]/page.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /historyOffsetFromQuery\(query\.historyOffset\)/u);
  assert.match(source, /fetchPromptVersions\(/u);
});
