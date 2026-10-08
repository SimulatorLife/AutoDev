import assert from "node:assert/strict";
import test from "node:test";

import type { ToolCatalogItem } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToolDetailView } from "../src/features/tools/ToolDetailView.ts";

/**
 * Every other detail view marks its panels with `data-section` --
 * `mcp-configuration`, `provider-models`, `agent-providers`,
 * `model-enablement`, `prompt-reconciliation`. The tools detail view had four
 * headed sections and no hook on any of them, so nothing could address one: a
 * test could not assert that the role-exposure panel rendered, and a browser
 * audit asking "did any section come out empty?" reported zero empty sections
 * because it had found zero sections to ask about. A check that cannot fail is
 * not a check.
 *
 * These assert the hooks exist *and* that each one carries content, so adding
 * a heading without a hook, or a hook on a section that renders nothing, both
 * fail.
 */

const TOOL: ToolCatalogItem = {
  name: "mcp__example__do_thing",
  source: "mcp",
  sourceAuthority: "rulesync-mcp",
  server: "example",
  description: "Does a thing.",
  exposedRoles: ["default"],
  availability: "configured",
  canonicalEditSurface: { section: "mcps", identifier: "example" }
};

const SECTIONS = [
  "tool-source-authority",
  "tool-role-exposure",
  "tool-description",
  "tool-historical-use"
];

test("every tools detail section carries a stable hook and some content", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolDetailView, {
      tool: TOOL,
      coverage: "complete",
      validity: "valid",
      usage: { calls: null, errors: null, observed: false },
      usageLink: "/usage",
      usageUnavailable: false
    })
  );

  const found = Array.from(markup.matchAll(/data-section="([^"]+)"/g), (m) => m[1]);
  assert.deepEqual(
    [...found].sort(),
    [...SECTIONS].sort(),
    `tools detail must expose exactly its four sections, got: ${found.join(", ") || "(none)"}`
  );

  for (const name of SECTIONS) {
    const open = markup.indexOf(`data-section="${name}"`);
    assert.notEqual(open, -1, `missing data-section="${name}"`);
    // The section element is a <section ...>...</section>; a hook on an empty
    // wrapper is the failure this is meant to catch.
    const start = markup.lastIndexOf("<section", open);
    const end = markup.indexOf("</section>", open);
    assert.ok(start !== -1 && end > open, `data-section="${name}" is not a section`);
    const body = markup.slice(open, end);
    assert.ok(
      body.replaceAll(/<[^>]*>/g, "").replaceAll(/\s+/g, " ").trim().length > 0,
      `data-section="${name}" rendered no text`
    );
  }
});

test("a tool with no description still renders its section", () => {
  // The empty case is the one worth pinning: a missing description must render
  // the inline empty state inside the section rather than dropping the section,
  // or the hook disappears exactly when a reader most wants to know why.
  // `exactOptionalPropertyTypes` is on, so the key has to be absent rather than
  // explicitly undefined.
  const { description: _omitted, ...withoutDescription } = TOOL;
  const markup = renderToStaticMarkup(
    React.createElement(ToolDetailView, {
      tool: withoutDescription,
      coverage: "complete",
      validity: "valid",
      usage: { calls: null, errors: null, observed: false },
      usageLink: "/usage",
      usageUnavailable: false
    })
  );
  for (const name of SECTIONS) {
    assert.match(
      markup,
      new RegExp(`data-section="${name}"`),
      `${name} disappeared when the tool had no description`
    );
  }
  assert.match(markup, /No description is shipped with this tool/u);
});