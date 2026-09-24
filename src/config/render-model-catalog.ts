import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeErrorLine, writeLine } from "../shared/output.ts";
import {
  atomicWrite,
  ConfigError,
  parseArgs,
  readJsonFile,
  requiredArg
} from "./toml.ts";

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
  smart:
    "Provider-neutral AutoDev smart role routed by the local model router."
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
  const defaultEffort = reasoningEffort ?? (isOrchestrator ? "xhigh" : isSmart ? "high" : "medium");

  let description = "OpenAI Codex model for implementation work.";
  if (isOrchestrator) {
    description = "OpenAI Codex model for orchestration and exploration.";
  } else if (isSmart) {
    description = "OpenAI Codex model for targeted research.";
  }

  const contextWindow = isSmart ? 400000 : 1000000;

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
      limit: 10000
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
    context_window: 1000000,
    max_context_window: 1000000,
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: true,
    support_verbosity: true,
    supports_search_tool: true,
    tool_mode: "code_mode_only",
    truncation_policy: {
      mode: "tokens",
      limit: 10000
    },
    experimental_supported_tools: [],
    use_responses_lite: true,
    multi_agent_version: "v1",
    input_modalities: ["text", "image"]
  };
}

export function renderModelCatalog(
  modelRoutingPath: string,
  catalogsDir: string
): string {
  const routing = readJsonFile(modelRoutingPath, "model routing configuration") as Record<
    string,
    any
  >;
  const codexModelsConfig = routing.providers?.codex?.models ?? {};
  const orchestratorEffort =
    routing.orchestrator?.reasoningEffort?.codex ?? "xhigh";

  const models: CatalogModelEntry[] = [];
  const addedSlugs = new Set<string>();

  // 1. Add configured Codex models
  const codexRoles: Array<[string, "orchestrator" | "smart" | "default"]> = [
    ["orchestrator", "orchestrator"],
    ["smart", "smart"],
    ["default", "default"]
  ];

  for (const [key, role] of codexRoles) {
    const slug = codexModelsConfig[key];
    if (typeof slug === "string" && slug && !addedSlugs.has(slug)) {
      const effort = role === "orchestrator" ? orchestratorEffort : undefined;
      models.push(buildCodexModelEntry(slug, role, effort));
      addedSlugs.add(slug);
    }
  }

  // Preserve standard implementation baseline if not already covered
  if (!addedSlugs.has("gpt-5.6-terra")) {
    models.splice(1, 0, buildCodexModelEntry("gpt-5.6-terra", "implementation", "medium"));
    addedSlugs.add("gpt-5.6-terra");
  }

  // Any other models in codex.models
  for (const [key, slug] of Object.entries(codexModelsConfig)) {
    if (typeof slug === "string" && slug && !addedSlugs.has(slug)) {
      models.push(buildCodexModelEntry(slug, "default"));
      addedSlugs.add(slug);
    }
  }

  // 2. Load provider catalogs (claude, minimax, antigravity)
  const providerCatalogFiles = [
    "claude-model-catalog.json",
    "minimax-model-catalog.json",
    "antigravity-model-catalog.json"
  ];

  for (const file of providerCatalogFiles) {
    const filePath = path.join(catalogsDir, file);
    if (!existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(parsed.models)) {
        for (const entry of parsed.models) {
          if (entry && typeof entry.slug === "string" && !addedSlugs.has(entry.slug)) {
            models.push(entry);
            addedSlugs.add(entry.slug);
          }
        }
      }
    } catch {
      // Ignore unparseable external catalogs
    }
  }

  // 3. Add AutoDev role aliases
  const roleNames = [
    "default",
    "orchestrator",
    "docs-researcher",
    "browser-tester",
    "explorer",
    "worker",
    "validator",
    "smart"
  ];

  for (const role of roleNames) {
    const slug = `autodev/${role}`;
    if (!addedSlugs.has(slug)) {
      models.push(buildRoleAliasEntry(role));
      addedSlugs.add(slug);
    }
  }

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
