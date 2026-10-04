import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVALUATION_DEFINITIONS_SCHEMA,
  EVALUATION_LIMITS,
  type EvaluationDefinition,
  type EvaluationDefinitionCatalogStatus,
  parseEvaluationDefinition
} from "@simulatorlife/autodev-core";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CATALOG_RELATIVE_PATH = path.join("config", "evaluations.json");
const MAX_REPORTED_ERRORS = 20;
/** Locale-pinned so the canonical file order never depends on the host. */
const ID_COLLATOR = new Intl.Collator("en");

export interface StoredEvaluationDefinition {
  readonly definition: EvaluationDefinition;
  /** Content hash of the canonical definition, used for optimistic concurrency. */
  readonly revision: string;
}

export interface EvaluationDefinitionCatalogRead {
  readonly status: EvaluationDefinitionCatalogStatus;
  readonly errors: readonly string[];
  readonly definitions: readonly StoredEvaluationDefinition[];
}

export type EvaluationDefinitionWriteFailure =
  | "catalog_unavailable"
  | "catalog_invalid"
  | "revision_conflict"
  | "not_found"
  | "limit_exceeded"
  | "persistence_failed";

export type EvaluationDefinitionWriteResult =
  | {
      readonly ok: true;
      readonly result: "created" | "updated" | "deleted";
      readonly revision: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: EvaluationDefinitionWriteFailure;
      readonly message: string;
    };

/** Canonical field order; serialization and revisions never depend on input order. */
export function canonicalEvaluationDefinition(
  definition: EvaluationDefinition
): EvaluationDefinition {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    enabled: definition.enabled,
    targets: definition.targets.map((target) => ({
      kind: target.kind,
      id: target.id,
      prompt: target.prompt
    })),
    criteria: definition.criteria.map((criterion) => ({
      type: criterion.type,
      threshold: criterion.threshold
    })),
    cases: definition.cases.map((entry) => ({
      id: entry.id,
      input: entry.input,
      context: entry.context
    })),
    judge: { model: definition.judge.model }
  };
}

export function evaluationDefinitionRevision(
  definition: EvaluationDefinition
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalEvaluationDefinition(definition)))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Typed owner of the canonical `config/evaluations.json` definition catalog.
 * Reads fail closed: one malformed definition invalidates the whole catalog
 * instead of silently dropping it. Writes are revision-checked and atomic.
 */
export class EvaluationDefinitionRepository {
  readonly repositoryRoot: string;
  readonly catalogPath: string;

  constructor(repositoryRoot: string = DEFAULT_REPO_ROOT) {
    this.repositoryRoot = repositoryRoot;
    this.catalogPath = path.join(repositoryRoot, CATALOG_RELATIVE_PATH);
  }

  readCatalog(): EvaluationDefinitionCatalogRead {
    if (!existsSync(this.catalogPath)) {
      return {
        status: "unavailable",
        errors: [`${CATALOG_RELATIVE_PATH} does not exist.`],
        definitions: []
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.catalogPath, "utf8"));
    } catch {
      return invalid([`${CATALOG_RELATIVE_PATH} is not valid JSON.`]);
    }
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some(
        (key) => key !== "schema" && key !== "definitions"
      ) ||
      (raw as { schema?: unknown }).schema !== EVALUATION_DEFINITIONS_SCHEMA ||
      !Array.isArray((raw as { definitions?: unknown }).definitions)
    ) {
      return invalid([
        `${CATALOG_RELATIVE_PATH} must be {"schema":"${EVALUATION_DEFINITIONS_SCHEMA}","definitions":[...]}.`
      ]);
    }
    const entries = (raw as { definitions: unknown[] }).definitions;
    if (entries.length > EVALUATION_LIMITS.maxDefinitions) {
      return invalid([
        `${CATALOG_RELATIVE_PATH} exceeds ${EVALUATION_LIMITS.maxDefinitions} definitions.`
      ]);
    }
    const errors: string[] = [];
    const definitions: StoredEvaluationDefinition[] = [];
    const ids = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const parsed = parseEvaluationDefinition(entry);
      if (!parsed.ok) {
        errors.push(
          ...parsed.errors.map((error) => `definitions[${index}]: ${error}`)
        );
        continue;
      }
      if (ids.has(parsed.definition.id)) {
        errors.push(
          `definitions[${index}]: duplicate id "${parsed.definition.id}".`
        );
        continue;
      }
      ids.add(parsed.definition.id);
      definitions.push({
        definition: parsed.definition,
        revision: evaluationDefinitionRevision(parsed.definition)
      });
    }
    if (errors.length > 0) return invalid(errors);
    definitions.sort((left, right) =>
      ID_COLLATOR.compare(left.definition.id, right.definition.id)
    );
    return { status: "valid", errors: [], definitions };
  }

  /** Create (expectedRevision null) or replace a definition at its revision. */
  upsert(
    definition: EvaluationDefinition,
    expectedRevision: string | null
  ): EvaluationDefinitionWriteResult {
    const catalog = this.writableCatalog();
    if (!catalog.ok) return catalog;
    const existing = catalog.definitions.find(
      (entry) => entry.definition.id === definition.id
    );
    if ((existing?.revision ?? null) !== expectedRevision) {
      return {
        ok: false,
        reason: "revision_conflict",
        message: existing
          ? `Definition "${definition.id}" changed since it was read.`
          : `Definition "${definition.id}" does not exist; create it without an expected revision.`
      };
    }
    if (
      !existing &&
      catalog.definitions.length >= EVALUATION_LIMITS.maxDefinitions
    ) {
      return {
        ok: false,
        reason: "limit_exceeded",
        message: `At most ${EVALUATION_LIMITS.maxDefinitions} evaluation definitions are supported.`
      };
    }
    const next = [
      ...catalog.definitions
        .filter((entry) => entry.definition.id !== definition.id)
        .map((entry) => entry.definition),
      definition
    ];
    const persisted = this.persist(next);
    if (!persisted.ok) return persisted;
    return {
      ok: true,
      result: existing ? "updated" : "created",
      revision: evaluationDefinitionRevision(definition)
    };
  }

  delete(
    id: string,
    expectedRevision: string
  ): EvaluationDefinitionWriteResult {
    const catalog = this.writableCatalog();
    if (!catalog.ok) return catalog;
    const existing = catalog.definitions.find(
      (entry) => entry.definition.id === id
    );
    if (!existing) {
      return {
        ok: false,
        reason: "not_found",
        message: `Definition "${id}" does not exist.`
      };
    }
    if (existing.revision !== expectedRevision) {
      return {
        ok: false,
        reason: "revision_conflict",
        message: `Definition "${id}" changed since it was read.`
      };
    }
    const persisted = this.persist(
      catalog.definitions
        .filter((entry) => entry.definition.id !== id)
        .map((entry) => entry.definition)
    );
    if (!persisted.ok) return persisted;
    return { ok: true, result: "deleted", revision: null };
  }

  private writableCatalog():
    | {
        readonly ok: true;
        readonly definitions: readonly StoredEvaluationDefinition[];
      }
    | Extract<EvaluationDefinitionWriteResult, { ok: false }> {
    const catalog = this.readCatalog();
    if (catalog.status === "valid") {
      return { ok: true, definitions: catalog.definitions };
    }
    return {
      ok: false,
      reason:
        catalog.status === "unavailable"
          ? "catalog_unavailable"
          : "catalog_invalid",
      message: `${CATALOG_RELATIVE_PATH} is ${catalog.status}; fix it before writing definitions.`
    };
  }

  private persist(
    definitions: readonly EvaluationDefinition[]
  ):
    | { readonly ok: true }
    | Extract<EvaluationDefinitionWriteResult, { ok: false }> {
    const sorted = [...definitions]
      .sort((left, right) => ID_COLLATOR.compare(left.id, right.id))
      .map(canonicalEvaluationDefinition);
    const content = `${JSON.stringify(
      { schema: EVALUATION_DEFINITIONS_SCHEMA, definitions: sorted },
      null,
      2
    )}\n`;
    const temporary = path.join(
      path.dirname(this.catalogPath),
      `.evaluations.${randomBytes(6).toString("hex")}.tmp`
    );
    try {
      writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
      renameSync(temporary, this.catalogPath);
      return { ok: true };
    } catch {
      rmSync(temporary, { force: true });
      return {
        ok: false,
        reason: "persistence_failed",
        message: `${CATALOG_RELATIVE_PATH} could not be written.`
      };
    }
  }
}

function invalid(errors: readonly string[]): EvaluationDefinitionCatalogRead {
  return {
    status: "invalid",
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    definitions: []
  };
}
