import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

import { parseArgs, requiredArg } from "./cli-args.ts";
import { atomicWrite, readJsonFile } from "./config-files.ts";

export interface CatalogModelEntry {
  slug: string;
  display_name: string;
  description: string;
  base_instructions?: string;
  model_messages?: { instructions_template: string };
  default_reasoning_level: string;
  supported_reasoning_levels: Array<{ effort: string; description?: string }>;
  shell_type: string;
  visibility: string;
  supported_in_api: boolean;
  priority: number;
  context_window: number;
  max_context_window: number;
  supports_parallel_tool_calls: boolean;
  supports_reasoning_summaries?: boolean;
  support_verbosity: boolean;
  supports_search_tool: boolean;
  tool_mode: string;
  truncation_policy: { mode: string; limit: number };
  experimental_supported_tools: unknown[];
  use_responses_lite: boolean;
  multi_agent_version: string;
  input_modalities: string[];
  [key: string]: unknown;
}

const STANDARD_REASONING_LEVELS = [
  { effort: "low", description: "Low reasoning" },
  { effort: "medium", description: "Balanced reasoning" },
  { effort: "high", description: "High reasoning" },
  { effort: "xhigh", description: "Extra-high reasoning" },
  { effort: "max", description: "Maximum reasoning" }
];

const RESEARCH_REASONING_LEVELS = [
  { effort: "low", description: "Low reasoning" },
  { effort: "medium", description: "Balanced reasoning" },
  { effort: "high", description: "High reasoning" }
];

const ROLE_DESCRIPTIONS: Record<string, string> = {
  default:
    "Provider-neutral AutoDev default role routed by the local model router.",
  orchestrator:
    "Root orchestrator alias: pinned to the primary provider, degrades across providers through the local model router when that provider is out of usage.",
  "docs-researcher":
    "Provider-neutral AutoDev docs-researcher role routed by the local model router.",
  "browser-tester":
    "Provider-neutral AutoDev browser-tester role routed by the local model router.",
  explorer:
    "Provider-neutral AutoDev explorer role routed by the local model router.",
  worker:
    "Provider-neutral AutoDev worker role routed by the local model router.",
  validator:
    "Provider-neutral AutoDev validator role routed by the local model router.",
  smart: "Provider-neutral AutoDev smart role routed by the local model router."
};

function formatDisplayName(slug: string): string {
  if (slug.startsWith("gpt-")) {
    const parts = slug.split("-");
    const prefix = parts.slice(0, 2).join("-").toUpperCase();
    const rest = parts
      .slice(2)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    return rest ? `${prefix} ${rest}` : prefix;
  }
  return slug
    .split(/[-_/]/g)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function buildCodexModelEntry(
  slug: string,
  role: "orchestrator" | "smart" | "default" | "implementation",
  reasoningEffort?: string
): CatalogModelEntry {
  const isSmart = role === "smart" || slug.includes("sol");
  const isOrchestrator = role === "orchestrator";
  const defaultEffort =
    reasoningEffort ?? (isOrchestrator ? "xhigh" : isSmart ? "high" : "medium");

  let description = "OpenAI Codex model for implementation work.";
  if (isOrchestrator) {
    description = "OpenAI Codex model for orchestration and exploration.";
  } else if (isSmart) {
    description = "OpenAI Codex model for targeted research.";
  }

  const contextWindow = isSmart ? 400_000 : 1_000_000;

  return {
    slug,
    display_name: formatDisplayName(slug),
    description,
    base_instructions: "You are a bounded Codex agent.",
    model_messages: {
      instructions_template: "You are a bounded Codex agent."
    },
    default_reasoning_level: defaultEffort,
    supported_reasoning_levels: isSmart
      ? RESEARCH_REASONING_LEVELS
      : STANDARD_REASONING_LEVELS,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    context_window: contextWindow,
    max_context_window: contextWindow,
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: true,
    support_verbosity: true,
    supports_search_tool: true,
    tool_mode: "code_mode_only",
    truncation_policy: {
      mode: "tokens",
      limit: 10_000
    },
    experimental_supported_tools: [],
    use_responses_lite: true,
    multi_agent_version: "v1",
    input_modalities: ["text", "image"]
  };
}

export function buildRoleAliasEntry(roleName: string): CatalogModelEntry {
  const slug = `autodev/${roleName}`;
  const description =
    ROLE_DESCRIPTIONS[roleName] ??
    `Provider-neutral AutoDev ${roleName} role routed by the local model router.`;
  const displayName =
    roleName === "orchestrator"
      ? "AutoDev orchestrator"
      : `AutoDev ${roleName} role`;

  return {
    slug,
    display_name: displayName,
    description,
    base_instructions: "You are a bounded provider-neutral AutoDev agent.",
    model_messages: {
      instructions_template: "You are a bounded provider-neutral AutoDev agent."
    },
    default_reasoning_level: "medium",
    supported_reasoning_levels: STANDARD_REASONING_LEVELS,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    context_window: 1_000_000,
    max_context_window: 1_000_000,
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: true,
    support_verbosity: true,
    supports_search_tool: true,
    tool_mode: "code_mode_only",
    truncation_policy: {
      mode: "tokens",
      limit: 10_000
    },
    experimental_supported_tools: [],
    use_responses_lite: true,
    multi_agent_version: "v1",
    input_modalities: ["text", "image"]
  };
}

interface CatalogRecord {
  slug: string;
  [key: string]: unknown;
}

const CODEX_ROLE_MODELS = [
  ["orchestrator", "orchestrator"],
  ["smart", "smart"],
  ["default", "default"]
] as const satisfies readonly (readonly [
  string,
  "orchestrator" | "smart" | "default"
])[];

const PROVIDER_CATALOG_FILES = [
  "claude-model-catalog.json",
  "minimax-model-catalog.json",
  "antigravity-model-catalog.json"
] as const;

const ROLE_ALIAS_NAMES = [
  "default",
  "orchestrator",
  "docs-researcher",
  "browser-tester",
  "explorer",
  "worker",
  "validator",
  "smart"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCatalogRecord(value: unknown): value is CatalogRecord {
  return isRecord(value) && typeof value.slug === "string";
}

function appendCodexModels(
  models: Array<CatalogModelEntry | CatalogRecord>,
  addedSlugs: Set<string>,
  routing: Record<string, unknown>
): void {
  const providers = isRecord(routing.providers) ? routing.providers : {};
  const codex = isRecord(providers.codex) ? providers.codex : {};
  const codexModels = isRecord(codex.models) ? codex.models : {};
  const orchestrator = isRecord(routing.orchestrator)
    ? routing.orchestrator
    : {};
  const reasoningEffort = isRecord(orchestrator.reasoningEffort)
    ? orchestrator.reasoningEffort
    : {};
  const configuredEffort = reasoningEffort.codex;
  const orchestratorEffort =
    typeof configuredEffort === "string" ? configuredEffort : "xhigh";

  for (const [key, role] of CODEX_ROLE_MODELS) {
    const slug = codexModels[key];
    if (typeof slug !== "string" || !slug || addedSlugs.has(slug)) continue;
    const effort = role === "orchestrator" ? orchestratorEffort : undefined;
    models.push(buildCodexModelEntry(slug, role, effort));
    addedSlugs.add(slug);
  }

  // Preserve the standard implementation baseline even when the source only
  // defines a smart/orchestrator model pair.
  if (!addedSlugs.has("gpt-5.6-terra")) {
    models.splice(
      1,
      0,
      buildCodexModelEntry("gpt-5.6-terra", "implementation", "medium")
    );
    addedSlugs.add("gpt-5.6-terra");
  }

  for (const slug of Object.values(codexModels)) {
    if (typeof slug !== "string" || !slug || addedSlugs.has(slug)) continue;
    models.push(buildCodexModelEntry(slug, "default"));
    addedSlugs.add(slug);
  }
}

function appendProviderCatalogModels(
  models: Array<CatalogModelEntry | CatalogRecord>,
  addedSlugs: Set<string>,
  catalogsDir: string
): void {
  for (const file of PROVIDER_CATALOG_FILES) {
    const filePath = path.join(catalogsDir, file);
    if (!existsSync(filePath)) continue;
    try {
      const catalog = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!isRecord(catalog) || !Array.isArray(catalog.models)) continue;
      for (const candidate of catalog.models) {
        if (!isCatalogRecord(candidate) || addedSlugs.has(candidate.slug))
          continue;
        models.push(candidate);
        addedSlugs.add(candidate.slug);
      }
    } catch {
      // Ignore malformed optional provider catalogs.
    }
  }
}

function appendRoleAliases(
  models: Array<CatalogModelEntry | CatalogRecord>,
  addedSlugs: Set<string>
): void {
  for (const role of ROLE_ALIAS_NAMES) {
    const slug = `autodev/${role}`;
    if (addedSlugs.has(slug)) continue;
    models.push(buildRoleAliasEntry(role));
    addedSlugs.add(slug);
  }
}

export function renderModelCatalog(
  modelRoutingPath: string,
  catalogsDir: string
): string {
  const routing = readJsonFile(modelRoutingPath, "model routing configuration");
  const models: Array<CatalogModelEntry | CatalogRecord> = [];
  const addedSlugs = new Set<string>();

  appendCodexModels(models, addedSlugs, routing);
  appendProviderCatalogModels(models, addedSlugs, catalogsDir);
  appendRoleAliases(models, addedSlugs);

  return `${JSON.stringify({ models }, null, 2)}\n`;
}

export function runModelCatalog(
  modelRoutingPath: string,
  catalogsDir: string,
  outputPath: string,
  check = false
): number {
  const rendered = renderModelCatalog(modelRoutingPath, catalogsDir);
  if (check) {
    if (
      existsSync(outputPath) &&
      !lstatSync(outputPath).isSymbolicLink() &&
      readFileSync(outputPath, "utf8") === rendered
    ) {
      writeLine(`ok codex model catalog ${outputPath}`);
      return 0;
    }
    writeLine(`missing-or-drifted codex model catalog ${outputPath}`);
    return 1;
  }
  atomicWrite(outputPath, rendered);
  writeLine(`rendered codex model catalog into ${outputPath}`);
  return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const { values, flags } = parseArgs(process.argv.slice(2));
    process.exitCode = runModelCatalog(
      requiredArg(values, "routing-config"),
      requiredArg(values, "catalogs-dir"),
      requiredArg(values, "output"),
      flags.has("check")
    );
  } catch (error) {
    writeErrorLine(
      `render-model-catalog: ${error instanceof Error ? error.message : error}`
    );
    process.exitCode = 2;
  }
}
