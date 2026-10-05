import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

async function fetchExistingPrompts(
  endpoint: string,
  clickhouseUrl: string
): Promise<Map<string, ExistingPromptRow>> {
  const res = await fetch(
    `${endpoint}&query=${encodeURIComponent("SELECT id, name, created_by FROM openlit_prompts FORMAT JSON")}`,
    { method: "GET" }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Failed to connect to ClickHouse at ${clickhouseUrl} (${res.status}): ${errText}`
    );
  }
  const json = (await res.json()) as { data?: ExistingPromptRow[] };
  const map = new Map<string, ExistingPromptRow>();
  for (const row of json.data || []) {
    map.set(row.name, row);
  }
  return map;
}

async function fetchExistingVersions(
  endpoint: string
): Promise<Map<string, ExistingVersionRow[]>> {
  const res = await fetch(
    `${endpoint}&query=${encodeURIComponent(
      "SELECT version_id, prompt_id, version, status, prompt, tags, meta_properties FROM openlit_prompt_versions FORMAT JSON"
    )}`,
    { method: "GET" }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Failed to query openlit_prompt_versions (${res.status}): ${errText}`
    );
  }
  const json = (await res.json()) as { data?: ExistingVersionRow[] };
  const map = new Map<string, ExistingVersionRow[]>();
  for (const row of json.data || []) {
    const list = map.get(row.prompt_id) || [];
    list.push(row);
    map.set(row.prompt_id, list);
  }
  return map;
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

async function removeStalePrompts(
  endpoint: string,
  staleRows: ExistingPromptRow[]
): Promise<string[]> {
  if (staleRows.length === 0) return [];
  const ids = staleRows.map((r) => `'${r.id}'`).join(", ");
  await fetch(
    `${endpoint}&query=${encodeURIComponent(
      `ALTER TABLE openlit_prompt_versions DELETE WHERE prompt_id IN (${ids})`
    )}`,
    { method: "POST" }
  );
  await fetch(
    `${endpoint}&query=${encodeURIComponent(
      `ALTER TABLE openlit_prompts DELETE WHERE id IN (${ids})`
    )}`,
    { method: "POST" }
  );
  return staleRows.map((r) => r.name);
}

async function bulkInsertPrompts(
  endpoint: string,
  prompts: Array<{ id: string; name: string; created_by: string }>
): Promise<void> {
  if (prompts.length === 0) return;
  const body = prompts.map((p) => JSON.stringify(p)).join("\n") + "\n";
  const res = await fetch(
    `${endpoint}&query=${encodeURIComponent("INSERT INTO openlit_prompts FORMAT JSONEachRow")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to bulk insert into openlit_prompts: ${await res.text()}`
    );
  }
}

async function bulkInsertVersions(
  endpoint: string,
  plans: PromptMutationPlan[]
): Promise<void> {
  if (plans.length === 0) return;
  const rows = plans.map((p) => ({
    version_id: p.versionId,
    prompt_id: p.promptId,
    updated_by: "rulesync",
    version: p.version,
    status: "PUBLISHED",
    prompt: p.prompt,
    tags: p.tags,
    meta_properties: p.metaProperties
  }));
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const res = await fetch(
    `${endpoint}&query=${encodeURIComponent(
      "INSERT INTO openlit_prompt_versions FORMAT JSONEachRow"
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to bulk insert into openlit_prompt_versions: ${await res.text()}`
    );
  }
}

/**
 * Synchronize rulesync-defined prompts from `.rulesync/commands/` into OpenLIT's ClickHouse tables.
 */
export async function syncRulesyncPrompts(
  options: SyncPromptsOptions = {}
): Promise<SyncPromptsResult> {
  const repositoryRoot =
    options.repositoryRoot || path.resolve(import.meta.dirname, "../../..");
  const { clickhouseUrl, endpoint } =
    resolveOpenLitClickHouseConnection(options);

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

  const existingPrompts = await fetchExistingPrompts(endpoint, clickhouseUrl);
  const existingVersions = await fetchExistingVersions(endpoint);

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
  const removed = await removeStalePrompts(endpoint, stalePrompts);

  await bulkInsertPrompts(endpoint, promptsToInsert);
  await bulkInsertVersions(endpoint, versionsToInsert);

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
