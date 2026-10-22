import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PromptPreviewControl,
  PromptSourcePreview
} from "../src/features/prompts/prompt-source-preview.ts";

/**
 * What the preview does while it is working, and what it says when it is done.
 *
 * Two properties, both measured in a browser before they were pinned here.
 *
 * The first is the operator's place. The control used to be disabled while the
 * request was in flight, and a disabled control is dropped out of the page's
 * focus order the moment it is disabled: the button had the focus, the
 * request started, the browser moved the focus to the document, and when the
 * answer came back the operator's next Tab started from the top of the page
 * instead of from the control they had just used.
 *
 * The second is what the operator heard. A preview that came back valid was
 * silent -- the panel appeared and nothing announced it -- while a preview
 * that came back refused spoke, because only the refusal carried a live
 * region. So the common case was the quiet one.
 */
test("the preview control keeps its focus while the request is in flight", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptPreviewControl, {
      pending: true,
      onPreview: () => {}
    })
  );

  assert.doesNotMatch(
    markup,
    /\sdisabled(?:="|[\s>])/u,
    "a disabled control is dropped out of the focus order, and the operator loses their place"
  );
  assert.match(
    markup,
    /aria-disabled="true"/u,
    "the control has to say it is busy while it is working"
  );
  assert.match(
    markup,
    /data-submitting="true"/u,
    "the busy state is published the way the Console's own form owner publishes it"
  );
  assert.match(
    markup,
    /Previewing…/u,
    "the pending state is visible, not only published"
  );
});

test("the idle preview control is neither busy nor disabled", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptPreviewControl, {
      pending: false,
      onPreview: () => {}
    })
  );

  assert.doesNotMatch(markup, /aria-disabled/u);
  assert.doesNotMatch(markup, /data-submitting/u);
  assert.match(markup, /Preview unsaved changes/u);
});

test("the island announces its outcome once", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptSourcePreview, {
      name: "audit",
      editorId: "prompt-content"
    })
  );

  // One live region, and it is the island's own: the refusal used to carry a
  // second one, so a refused preview was announced twice while a valid one
  // was not announced at all.
  assert.equal(
    markup.match(/aria-live="polite"/gu)?.length,
    1,
    "the island announces its outcome through one region"
  );
  assert.match(
    markup,
    /class="sr-only"/u,
    "the announcement is for the operator's ear, not for the page"
  );
  assert.doesNotMatch(
    markup,
    /data-prompt-unsaved-preview-body="invalid"[^>]*role="status"/u,
    "the refusal is announced by the island's own region, not by a second one"
  );
});

test("the island says nothing until the operator asks", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptSourcePreview, {
      name: "audit",
      editorId: "prompt-content"
    })
  );

  assert.match(markup, /data-prompt-preview-hint="true"/u);
  assert.doesNotMatch(markup, /data-prompt-unsaved-preview/u);
  assert.doesNotMatch(
    markup,
    /The unsaved source was refused/u,
    "nothing is announced before the operator asks for a preview"
  );
});
