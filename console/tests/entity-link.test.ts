import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENTITY_LINK_CLASS,
  MONO_ID_LINK_CLASS
} from "../src/components/ui/text-classes.ts";

const FEATURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/features"
);

/**
Every feature source file, so a rule about feature views is checked against
all of them rather than against the ones somebody remembered.
*/
function featureFiles(directory = FEATURES): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...featureFiles(full));
      continue;
    }
    if (/\.tsx?$/u.test(entry.name)) files.push(full);
  }
  return files;
}

/**
The Console's link to a named entity — a provider, model, agent, prompt or
server you can open — is one interactive role with one hover treatment.

It had three. `/mcps` and `/tools` signalled the link by shifting to the
accent colour; `/agents` and `/prompts` signalled it by underlining;
`/github`'s provider summary did both. Fifty-nine links did one thing and
seventy-nine the other for the same gesture, so what a link looked like
depended on which page the operator had come from.

These pin the decision rather than the diff. The *action* link is a
different role — already accent-coloured at rest, underlining on hover —
and it has its own shared treatment, so a view that writes the accent and
the underline out by hand is writing a second treatment for the same
gesture rather than a variant of this one.
*/

const ENTITY_LINK_VIEWS = [
  "agents/AgentsView.ts",
  "prompts/PromptsView.ts",
  "providers/ModelDetailView.ts",
  "providers/ProviderDetailView.ts",
  "providers/ProviderTableColumns.ts",
  "mcps/McpsView.ts",
  "tools/ToolsView.ts",
  "hooks/HooksView.ts"
];

test("the entity link signals both, not one or the other", () => {
  assert.match(
    ENTITY_LINK_CLASS,
    /hover:text-accent/u,
    "the accent shift is one half"
  );
  assert.match(
    ENTITY_LINK_CLASS,
    /hover:underline/u,
    "the underline is the other"
  );
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
    const source = readFileSync(join(FEATURES, rel), "utf8");
    const usesShared =
      source.includes("ENTITY_LINK_CLASS") || source.includes("MONO_ID_LINK_CLASS");
    if (!usesShared) offenders.push(`${rel}: uses neither shared class`);
    // The hand-spelled form that predates the constant.
    if (/underline-offset-4\s+hover:underline/u.test(source)) {
      offenders.push(`${rel}: still spells the underline pair inline`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("no view spells the action link's treatment by hand", () => {
  // The accent and the underline are the action link's whole treatment, and
  // the playtesting strand wrote the pair out twenty-odd times without the
  // underline offset the shared treatment carries -- so the same gesture
  // underlined at two different offsets depending on the page.
  const offenders: string[] = [];
  for (const file of featureFiles()) {
    const source = readFileSync(file, "utf8");
    if (/text-accent[^"'\s]*\s+hover:underline/u.test(source)) {
      offenders.push(`${file}: spells the accent underline pair inline`);
      continue;
    }
    if (
      source.includes("hover:underline") &&
      !source.includes("ACTION_LINK_CLASS") &&
      !source.includes("ENTITY_LINK_CLASS")
    ) {
      offenders.push(`${file}: underlines on hover with no shared treatment`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
