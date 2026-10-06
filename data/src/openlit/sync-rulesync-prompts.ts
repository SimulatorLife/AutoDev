import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  groupRowsBy,
  indexRowsBy,
  insertRows,
  removeStaleRows,
  selectRows,
  type StaleRowProjection
} from "../clickhouse/clickhouse-client.ts";
import { RuleSyncRepository } from "../rulesync/rulesync-repository.ts";
import {
  type OpenLitClickHouseOptions,
  resolveOpenLitClickHouseConnection
} from "./clickhouse-config.ts";

export interface SyncPromptsOptions extends OpenLitClickHouseOptions {
  readonly repositoryRoot?: string;
  readonly silent?: boolean;
}

export interface SyncPromptsResult {
  readonly totalCatalogPrompts: number;
  readonly inserted: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
}

interface ExistingPromptRow {
  readonly id: string;
  readonly name: string;
  readonly created_by: string;
}

interface ExistingVersionRow {
  readonly version_id: string;
  readonly prompt_id: string;
  readonly version: string;
  readonly status: string;
  readonly prompt: string;
  readonly tags: string;
  readonly meta_properties: string;
}

interface PromptMutationPlan {
  readonly promptId: string;
  readonly name: string;
  readonly versionId: string;
  readonly version: string;
  readonly prompt: string;
  readonly tags: string;
  readonly metaProperties: string;
}

const PROMPTS_TABLE = "openlit_prompts";
const PROMPT_VERSIONS_TABLE = "openlit_prompt_versions";

const STALE_PROMPT_ROWS: StaleRowProjection<ExistingPromptRow> = {
  versionsTable: PROMPT_VERSIONS_TABLE,
  versionsKeyColumn: "prompt_id",
  summaryTable: PROMPTS_TABLE,
  summaryKeyColumn: "id",
  keyOf: (row) => row.id,
  labelOf: (row) => row.name
};

const NUMERIC_COLLATOR = new Intl.Collator(undefined, { numeric: true });

/**
 * Deterministic UUIDv5 generator (RFC 4122) from a string key using SHA-1.
 * Ensures stable IDs across syncs without requiring state files.
 */
export function deterministicUuid(input: string): string {
  const hash = createHash("sha1").update(input).digest("hex");
  const timeHi = `5${hash.slice(13, 16)}`;
  const clockSeq = `${((Number.parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hash.slice(18, 20)}`;
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    timeHi,
    clockSeq,
    hash.slice(20, 32)
  ].join("-");
}

function computeNextVersion(currentVersion: string | undefined): string {
  if (!currentVersion) return "1.0.0";
  const parts = currentVersion.split(".").map((p) => Number.parseInt(p));
  if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
    const patch = parts[2] ?? 0;
    parts[2] = patch + 1;
    return parts.join(".");
  }
  return `${currentVersion}.1`;
}

/**
 * Synchronize rulesync-defined prompts from `.rulesync/commands/` into OpenLIT's ClickHouse tables.
 */
export async function syncRulesyncPrompts(
  options: SyncPromptsOptions = {}
): Promise<SyncPromptsResult> {
  const repositoryRoot =
    options.repositoryRoot || path.resolve(import.meta.dirname, "../../..");
  const { endpoint } = resolveOpenLitClickHouseConnection(options);

  const source = new RuleSyncRepository(repositoryRoot).loadCommands();
  if (source.valid !== true) {
    throw new Error(
      source.valid === null
        ? "The canonical RuleSync command directory was not observed."
        : "The canonical RuleSync command directory is invalid."
    );
  }
  const catalog = new Map(
    source.commands.map((command) => [
      command.name,
      {
        name: command.name,
        description: command.description ?? "",
        targets: command.targets,
        prompt: command.prompt
      }
    ])
  );

  const existingPrompts = indexRowsBy(
    await selectRows<ExistingPromptRow>(endpoint, PROMPTS_TABLE, [
      "id",
      "name",
      "created_by"
    ]),
    (row) => row.name
  );
  const existingVersions = groupRowsBy(
    await selectRows<ExistingVersionRow>(endpoint, PROMPT_VERSIONS_TABLE, [
      "version_id",
      "prompt_id",
      "version",
      "status",
      "prompt",
      "tags",
      "meta_properties"
    ]),
    (row) => row.prompt_id
  );

  const inserted: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  const promptsToInsert: Array<{
    id: string;
    name: string;
    created_by: string;
  }> = [];
  const versionsToInsert: PromptMutationPlan[] = [];

  for (const [name, data] of catalog) {
    const promptId = deterministicUuid(`autodev:prompt:${name}`);
    const tags = JSON.stringify(["rulesync", "command", ...data.targets]);
    const metaProperties = JSON.stringify({
      description: data.description,
      targets: data.targets
    });

    const existingPrompt = existingPrompts.get(name);
    if (existingPrompt) {
      const versions = existingVersions.get(existingPrompt.id) || [];
      const latest = versions
        .filter((v) => v.status === "PUBLISHED")
        .sort((a, b) => NUMERIC_COLLATOR.compare(b.version, a.version))[0];

      if (
        latest &&
        latest.prompt === data.prompt &&
        latest.tags === tags &&
        latest.meta_properties === metaProperties
      ) {
        unchanged.push(name);
      } else {
        const nextVer = computeNextVersion(latest?.version);
        const versionId = deterministicUuid(
          `autodev:prompt-version:${name}:${nextVer}`
        );
        versionsToInsert.push({
          promptId: existingPrompt.id,
          name,
          versionId,
          version: nextVer,
          prompt: data.prompt,
          tags,
          metaProperties
        });
        updated.push(name);
      }
    } else {
      promptsToInsert.push({ id: promptId, name, created_by: "rulesync" });
      const versionId = deterministicUuid(
        `autodev:prompt-version:${name}:1.0.0`
      );
      versionsToInsert.push({
        promptId,
        name,
        versionId,
        version: "1.0.0",
        prompt: data.prompt,
        tags,
        metaProperties
      });
      inserted.push(name);
    }
  }

  const stalePrompts = [...existingPrompts.values()].filter(
    (row) => row.created_by === "rulesync" && !catalog.has(row.name)
  );
  const removed = await removeStaleRows(
    endpoint,
    stalePrompts,
    STALE_PROMPT_ROWS
  );

  await insertRows(endpoint, PROMPTS_TABLE, promptsToInsert);
  await insertRows(
    endpoint,
    PROMPT_VERSIONS_TABLE,
    versionsToInsert.map((plan) => ({
      version_id: plan.versionId,
      prompt_id: plan.promptId,
      updated_by: "rulesync",
      version: plan.version,
      status: "PUBLISHED",
      prompt: plan.prompt,
      tags: plan.tags,
      meta_properties: plan.metaProperties
    }))
  );

  return {
    totalCatalogPrompts: catalog.size,
    inserted,
    updated,
    unchanged,
    removed
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncRulesyncPrompts()
    .then((result) => {
      const lines = [
        `Synchronized ${result.totalCatalogPrompts} rulesync prompts to AutoDev Prompt Hub:`,
        `  Inserted:  ${result.inserted.length}`,
        `  Updated:   ${result.updated.length}`,
        `  Unchanged: ${result.unchanged.length}`
      ];
      if (result.removed.length > 0)
        lines.push(`  Removed:   ${result.removed.length}`);
      process.stdout.write(`${lines.join("\n")}\n`);
      process.exitCode = 0;
      return result;
    })
    .catch((error) => {
      process.stderr.write(
        `Prompts synchronization failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
      return null;
    });
}
