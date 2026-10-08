import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  controlApiCredentialUnavailable,
  ResourceUnavailable
} from "../app/_console.ts";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../app");

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (/page\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

test("the shared guard renders exactly what the per-page copy rendered", () => {
  // Every page used to spell this element inline. The helper replaces those
  // spellings, so the only thing that makes it safe is that it produces the
  // same element -- not a similar one. Compare against the inline form the
  // pages were rewritten from, for each noun any page actually passes.
  const nouns = [
    "agent configuration",
    "canonical prompt content",
    "canonical prompts",
    "evaluation results",
    "GitHub workflow definitions",
    "governed memory",
    "hook configuration",
    "MCP server configuration",
    "model configuration",
    "permission policy",
    "provider configuration",
    "skill configuration",
    "tool catalog data",
    "workspace configuration"
  ];

  for (const reads of nouns) {
    const inline = renderToStaticMarkup(
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message: `Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read ${reads}.`
      })
    );
    assert.equal(
      renderToStaticMarkup(controlApiCredentialUnavailable(reads)),
      inline,
      `guard for ${JSON.stringify(reads)} must render identically`
    );
  }
});

test("the credential guard still names the variable and the surface", () => {
  const markup = renderToStaticMarkup(
    controlApiCredentialUnavailable("governed memory")
  );
  assert.match(markup, /Control API credential is not configured/);
  assert.match(markup, /data-error-code="autodev_control_api_disabled"/);
  assert.match(
    markup,
    /Set AUTODEV_CONTROL_API_TOKEN in the Next\.js server environment to read governed memory\./u
  );
});

test("every page shares one guard, and names its own surface in it", () => {
  // The duplication this replaced was eighteen copies of the same title and the
  // same machine code, so that a renamed environment variable or a retitled
  // shell meant eighteen edits and the seventeen nobody remembered would keep
  // pointing at a variable that no longer exists. The code is load-bearing past
  // the page -- tests assert on data-error-code and logs match on it -- so it
  // has to stay in one definition.
  const using = [];
  const spelling = [];

  for (const file of pageFiles(APP)) {
    const src = readFileSync(file, "utf8");
    const at = relative(APP, file);
    if (src.includes("autodev_control_api_disabled")) spelling.push(at);
    const calls = [...src.matchAll(/controlApiCredentialUnavailable\(\s*"([^"]*)"\s*\)/gu)];
    if (calls.length > 0) {
      using.push(at);
      for (const [, noun] of calls) {
        assert.notEqual(noun.trim(), "", `${at} names no surface`);
        // Render through the real helper, so a page that passed a noun the
        // sentence cannot hold fails here rather than on a page nobody visits.
        const markup = renderToStaticMarkup(
          controlApiCredentialUnavailable(noun)
        );
        assert.ok(
          markup.includes(
            `Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read ${noun}.`
          ),
          `${at} does not render its own surface into the message`
        );
      }
    }
  }

  assert.deepEqual(spelling, [], `pages still spelling the guard inline:\n${spelling.join("\n")}`);
  // Guard against the sweep quietly finding nothing: the pages that used to
  // carry an inline copy are the ones that must now call the helper.
  assert.ok(using.length >= 18, `expected 18+ pages using the helper, found ${using.length}`);
});