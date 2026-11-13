import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProviderBrowserControls } from "../src/features/providers/ProviderBrowserControls.ts";

function render(dedicated: boolean): string {
  return renderToStaticMarkup(
    React.createElement(ProviderBrowserControls, {
      provider: "opencli-chatgpt",
      browser: { dedicated },
      returnTo: "/providers/opencli-chatgpt"
    })
  );
}

test("the Dedicated browser toggle is off by default and turns the dedicated browser on", () => {
  const html = render(false);
  assert.match(html, /action="\/api\/providers\/opencli-chatgpt\/browser"/);
  assert.match(html, /name="dedicated" value="true"/);
  assert.match(html, /name="provider" value="opencli-chatgpt"/);
  assert.match(html, /name="returnTo" value="\/providers\/opencli-chatgpt"/);
  assert.match(html, /data-provider-browser="extension"/);
  assert.match(html, /Dedicated browser: Off/);
  assert.match(html, />Turn on<\/button>/);
  assert.match(html, /OpenCLI tab group/);
});

test("with the dedicated browser on, the toggle returns to the operator's Chrome", () => {
  const html = render(true);
  assert.match(html, /name="dedicated" value="false"/);
  assert.match(html, /data-provider-browser="dedicated"/);
  assert.match(html, /Dedicated browser: On/);
  assert.match(html, />Turn off<\/button>/);
  assert.match(html, /Chrome for Testing/);
});
