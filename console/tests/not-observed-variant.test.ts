import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../src/components/status/StatusBadge.ts";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

test("the shared not-observed variant renders the product's own word for it", () => {
  // The consolidation below drops `label: NOT_OBSERVED_LABEL` from every
  // not-observed badge, on the strength of this one fact: with no label,
  // StatusBadge already reads NOT_OBSERVED_LABEL for this variant. If the
  // component's default ever stopped agreeing with the constant, every dropped
  // label would quietly become a different word on the page.
  const markup = renderToStaticMarkup(
    React.createElement(StatusBadge, { status: NOT_OBSERVED_STATUS })
  );
  assert.match(markup, new RegExp(`>${NOT_OBSERVED_LABEL}<`));
  assert.match(markup, new RegExp(`data-status="${NOT_OBSERVED_STATUS}"`));

  // Passing the label explicitly is what the call sites used to do, and it
  // must render identically -- that is the whole claim being relied on.
  const explicit = renderToStaticMarkup(
    React.createElement(StatusBadge, {
      status: NOT_OBSERVED_STATUS,
      label: NOT_OBSERVED_LABEL
    })
  );
  assert.equal(explicit, markup);
});

test("the not-observed variant is spelled once, in the module that owns it", () => {
  // `NOT_OBSERVED_LABEL` was already collected into StatusBadge after being
  // declared locally in eight feature files; the variant beside it was not,
  // and ended up declared in seven files and written as a bare literal at six
  // more. TypeScript caught a wrong key throughout, so nothing was ever
  // misspelled -- but a change to the key meant thirteen edits across seven
  // files, six of them invisible to a grep for the constant.
  //
  // This asserts the shape of the tree, not the behaviour of a page: it is the
  // only thing that fails when a new local declaration is added back.
  const offenders: string[] = [];
  const declaring = /^(?!export\s)\bconst\s+NOT_OBSERVED_STATUS\b/m;
  const redeclaring = /^export\s+const\s+NOT_OBSERVED_STATUS\b/m;

  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    const at = relative(SRC, file);
    // The owning module is the one declaration allowed to exist.
    if (at.endsWith("components/status/StatusBadge.ts")) continue;
    if (declaring.test(src) || redeclaring.test(src)) {
      offenders.push(`${at}: re-declares NOT_OBSERVED_STATUS`);
    }
    if (/status:\s*["']not-observed["']/.test(src)) {
      offenders.push(`${at}: passes the bare "not-observed" literal`);
    }
  }

  assert.deepEqual(offenders, [], offenders.join("\n"));
});