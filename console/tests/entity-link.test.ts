import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENTITY_LINK_CLASS,
  MONO_ID_LINK_CLASS
} from "../src/components/ui/text-classes.ts";

const FEATURES = resolve(dirname(fileURLToPath(import.meta.url)), "../src/features");

/**
 * The Console's link to a named entity — a provider, model, agent, prompt or
 * server you can open — is one interactive role with one hover treatment.
 *
 * It had three. `/mcps` and `/tools` signalled the link by shifting to the
 * accent colour; `/agents` and `/prompts` signalled it by underlining;
 * `/github`'s provider summary did both. Fifty-nine links did one thing and
 * seventy-nine the other for the same gesture, so what a link looked like
 * depended on which page the operator had come from.
 *
 * These pin the decision rather than the diff. `/evaluations` and `/usage`
 * still spell `text-accent ... hover:underline` inline, which is a *different*
 * role -- an action link, already accent-coloured at rest -- so this asserts
 * about the entity-link views specifically rather than banning the pair
 * outright.
 */

const ENTITY_LINK_VIEWS = [
  "agents/AgentsView.ts",
  "prompts/PromptsView.ts",
  "providers/ModelDetailView.ts",
  "providers/ProviderDetailView.ts",
  "providers/ProvidersView.ts",
  "mcps/McpsView.ts",
  "tools/ToolsView.ts"
];

test("the entity link signals both, not one or the other", () => {
  assert.match(ENTITY_LINK_CLASS, /hover:text-accent/u, "the accent shift is one half");
  assert.match(ENTITY_LINK_CLASS, /hover:underline/u, "the underline is the other");
  assert.match(ENTITY_LINK_CLASS, /underline-offset-4/u);
});

test("the shared name-link class composes the entity treatment", () => {
  // Composition rather than restatement: if these two drift apart again the
  // name links and the inline entity links disagree, which is the original
  // defect one layer down.
  assert.ok(
    MONO_ID_LINK_CLASS.includes(ENTITY_LINK_CLASS),
    `MONO_ID_LINK_CLASS must contain ENTITY_LINK_CLASS, got ${MONO_ID_LINK_CLASS}`
  );
});

test("no entity-link view spells its own hover treatment", () => {
  const offenders: string[] = [];
  for (const rel of ENTITY_LINK_VIEWS) {
    const src = readFileSync(join(FEATURES, rel), "utf8");
    const usesShared =
      src.includes("ENTITY_LINK_CLASS") || src.includes("MONO_ID_LINK_CLASS");
    if (!usesShared) offenders.push(`${rel}: uses neither shared class`);
    // The hand-spelled form that predates the constant.
    if (/underline-offset-4\s+hover:underline/u.test(src)) {
      offenders.push(`${rel}: still spells the underline pair inline`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});