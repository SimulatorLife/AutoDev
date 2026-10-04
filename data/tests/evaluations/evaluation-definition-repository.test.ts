import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { EvaluationDefinition } from "@simulatorlife/autodev-core";

import {
  EvaluationDefinitionRepository,
  evaluationDefinitionRevision
} from "../../src/evaluations/evaluation-definition-repository.ts";

const DEFINITION: EvaluationDefinition = {
  id: "worker-regression",
  name: "Worker regression",
  description: null,
  enabled: true,
  targets: [{ kind: "agent", id: "worker", prompt: null }],
  criteria: [{ type: "hallucination", threshold: 0.5 }],
  cases: [{ id: "case-1", input: "Summarize the README.", context: null }],
  judge: { model: "autodev/validator" }
};

function workspace(catalog?: unknown): {
  root: string;
  catalogPath: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-evaluations-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  const catalogPath = path.join(root, "config", "evaluations.json");
  if (catalog !== undefined) {
    writeFileSync(
      catalogPath,
      typeof catalog === "string" ? catalog : JSON.stringify(catalog)
    );
  }
  return {
    root,
    catalogPath,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test("readCatalog distinguishes unavailable, invalid, and valid catalogs", () => {
  const missing = workspace();
  try {
    const read = new EvaluationDefinitionRepository(missing.root).readCatalog();
    assert.equal(read.status, "unavailable");
    assert.deepEqual(read.definitions, []);
  } finally {
    missing.cleanup();
  }

  for (const catalog of [
    "{not json",
    { schema: "other", definitions: [] },
    { schema: "autodev-evaluations-v1", definitions: [], extra: true },
    {
      schema: "autodev-evaluations-v1",
      definitions: [DEFINITION, { ...DEFINITION, id: "BAD" }]
    },
    { schema: "autodev-evaluations-v1", definitions: [DEFINITION, DEFINITION] }
  ]) {
    const invalid = workspace(catalog);
    try {
      const read = new EvaluationDefinitionRepository(
        invalid.root
      ).readCatalog();
      assert.equal(read.status, "invalid");
      assert.deepEqual(read.definitions, []);
      assert.ok(read.errors.length > 0);
    } finally {
      invalid.cleanup();
    }
  }

  const valid = workspace({
    schema: "autodev-evaluations-v1",
    definitions: [{ ...DEFINITION, id: "zeta" }, DEFINITION]
  });
  try {
    const read = new EvaluationDefinitionRepository(valid.root).readCatalog();
    assert.equal(read.status, "valid");
    assert.deepEqual(
      read.definitions.map((entry) => entry.definition.id),
      ["worker-regression", "zeta"]
    );
    assert.equal(
      read.definitions[0]?.revision,
      evaluationDefinitionRevision(DEFINITION)
    );
  } finally {
    valid.cleanup();
  }
});

test("upsert and delete are revision-checked, canonical, and atomic", () => {
  const fixture = workspace({
    schema: "autodev-evaluations-v1",
    definitions: []
  });
  try {
    const repository = new EvaluationDefinitionRepository(fixture.root);

    const created = repository.upsert(DEFINITION, null);
    assert.deepEqual(created, {
      ok: true,
      result: "created",
      revision: evaluationDefinitionRevision(DEFINITION)
    });

    const stale = repository.upsert({ ...DEFINITION, name: "Renamed" }, null);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.reason, "revision_conflict");

    const updated = repository.upsert(
      { ...DEFINITION, name: "Renamed" },
      evaluationDefinitionRevision(DEFINITION)
    );
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.equal(updated.result, "updated");

    const written = readFileSync(fixture.catalogPath, "utf8");
    assert.ok(written.endsWith("}\n"));
    const parsed = JSON.parse(written) as {
      definitions: Array<Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(parsed.definitions[0]!), [
      "id",
      "name",
      "description",
      "enabled",
      "targets",
      "criteria",
      "cases",
      "judge"
    ]);
    assert.deepEqual(
      readdirSync(path.join(fixture.root, "config")),
      ["evaluations.json"],
      "no temporary files remain after an atomic write"
    );

    const conflict = repository.delete(DEFINITION.id, "0000000000000000");
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.reason, "revision_conflict");

    assert.deepEqual(repository.delete(DEFINITION.id, updated.revision!), {
      ok: true,
      result: "deleted",
      revision: null
    });
    const missing = repository.delete(DEFINITION.id, updated.revision!);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "not_found");
    assert.equal(repository.readCatalog().definitions.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("writes refuse to replace an invalid or missing catalog", () => {
  const invalid = workspace("{broken");
  try {
    const result = new EvaluationDefinitionRepository(invalid.root).upsert(
      DEFINITION,
      null
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "catalog_invalid");
    assert.equal(readFileSync(invalid.catalogPath, "utf8"), "{broken");
  } finally {
    invalid.cleanup();
  }

  const missing = workspace();
  try {
    const result = new EvaluationDefinitionRepository(missing.root).upsert(
      DEFINITION,
      null
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "catalog_unavailable");
  } finally {
    missing.cleanup();
  }
});

test("the shipped canonical catalog is valid", () => {
  const read = new EvaluationDefinitionRepository().readCatalog();
  assert.equal(read.status, "valid");
});
