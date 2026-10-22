import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { POST } from "../app/api/prompts/preview/route.ts";
import { PromptSourcePreview } from "../src/features/prompts/prompt-source-preview.ts";
import { PromptDetailView } from "../src/features/prompts/PromptDetailView.ts";
import { previewPromptSource } from "../src/lib/server/prompt-preview.ts";
import { promptDocumentFromControlApi } from "../src/lib/server/views.ts";

/**
 * The preview of a canonical prompt source the operator has not saved.
 *
 * The editor is the only place the unsaved source exists, and the reason to
 * preview it is to look before saving: a save rewrites the canonical file,
 * regenerates the projection and may need a restart. So the preview has to
 * answer "what will this look like" without writing anything, and it has to
 * answer it with the same parser the save validates with -- a preview that
 * read the front matter itself would be a second reader of the canonical
 * format, and the two could disagree about the same text.
 */

const COMMAND = "dry";
const VALID_SOURCE =
  "---\ntargets: [codexcli]\ndescription: Review source.\n---\n\n# Audit\n\n**Use a dry run.**\n";
const INVALID_SOURCE = "# Audit\n\nNo frontmatter here.\n";

function previewRequest(
  body: unknown,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest("http://console.test/api/prompts/preview", {
    method: "POST",
    headers: {
      origin: "http://console.test",
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("the preview is the body the canonical parser reads from the source", () => {
  const preview = previewPromptSource(COMMAND, VALID_SOURCE);
  assert.equal(preview.valid, true);
  assert.equal(preview.error, null);
  // The front matter is not part of the prompt body, and the body is what the
  // saved preview shows -- so the unsaved preview and the saved one are the
  // same kind of text.
  assert.equal(preview.preview, "# Audit\n\n**Use a dry run.**");
  assert.doesNotMatch(preview.preview, /description:/u);
});

test("a source the canonical parser refuses is reported with its own reason", () => {
  const preview = previewPromptSource(COMMAND, INVALID_SOURCE);
  assert.equal(preview.valid, false);
  assert.equal(preview.preview, "");
  // The reason is the parser's own, so the operator sees the message the save
  // would refuse the source with rather than a second wording of the fault.
  assert.match(preview.error ?? "", /frontmatter/u);
});

test("the preview route answers a same-origin request with the preview", async () => {
  const response = await POST(
    previewRequest({ name: COMMAND, content: VALID_SOURCE })
  );
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.deepEqual(body, {
    valid: true,
    preview: "# Audit\n\n**Use a dry run.**",
    error: null
  });
});

test("the preview route refuses a request that is not same-origin", async () => {
  const response = await POST(
    previewRequest(
      { name: COMMAND, content: VALID_SOURCE },
      { origin: "http://elsewhere.test", "sec-fetch-site": "cross-site" }
    )
  );
  assert.equal(response.status, 403);
});

test("the preview route refuses a body it cannot read", async () => {
  for (const body of [
    { content: VALID_SOURCE },
    { name: COMMAND },
    { name: "Not A Slug", content: VALID_SOURCE },
    "not json"
  ]) {
    const response = await POST(previewRequest(body));
    assert.equal(
      response.status,
      400,
      `expected ${JSON.stringify(body)} to be refused`
    );
  }
});

test("the editor offers the preview of the unsaved source", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptSourcePreview, {
      name: COMMAND,
      editorId: "prompt-content"
    })
  );
  assert.match(markup, /data-prompt-source-preview="true"/);
  assert.match(markup, /data-prompt-preview-hint="true"/);
  assert.match(markup, /Preview unsaved changes/);
  // Nothing is previewed until the operator asks: the preview is a read of
  // the editor's unsaved text, and the page has none yet.
  assert.doesNotMatch(markup, /data-prompt-unsaved-preview/u);
});

test("the prompt page carries the preview beside the editor it reads", () => {
  const prompt = promptDocumentFromControlApi({
    schema: "autodev-control-prompt-detail-v4",
    name: COMMAND,
    type: "command",
    source: `.rulesync/commands/${COMMAND}.md`,
    content: VALID_SOURCE,
    preview: "# Audit\n\n**Use a dry run.**",
    revision: "a".repeat(64),
    diff: {
      summary: "Canonical RuleSync command.",
      identifier: "a".repeat(64)
    },
    reconciliation: {
      status: {
        convergence: "not-observed",
        desiredGeneration: null,
        observedGeneration: null,
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: "Not observed."
      },
      history: []
    }
  });
  const markup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      prompt,
      reconciliation: {
        status: {
          convergence: "not-observed",
          desiredGeneration: null,
          observedGeneration: null,
          lastApplyAt: null,
          lastObservationAt: null,
          lastError: null,
          explanation: "Not observed."
        },
        history: []
      },
      history: {
        status: "unavailable",
        message: "Git history is unavailable in this test."
      }
    })
  );
  assert.match(markup, /data-prompt-source-preview="true"/);
  // The island reads the editor's unsaved text out of the document, so the two
  // have to name the same control.
  assert.match(markup, /id="prompt-content"/);
});
