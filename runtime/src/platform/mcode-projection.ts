/*
Thin RuleSync projection adapter for MiniMax Code (`mcode`).

`rulesync` v43.11.0 includes a `mimocode` target (MiMo Code), not MiniMax's
`mcode` CLI. This adapter reads the canonical `.rulesync/` sources and writes
deterministic `mcode` configuration (`AGENTS.md`, `mcp.json`, `hooks.json`,
`permissions.json`) into the target `mcodeHome` directory, with `--check`
parity verification.
*/

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";

const FILE_NAME_COLLATOR = new Intl.Collator();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface McodeProjectionFiles {
  readonly agentsMd: string;
  readonly mcpJson: string;
  readonly hooksJson: string;
  readonly permissionsJson: string;
}

export interface McodeProjectionResult {
  readonly mcodeHome: string;
  readonly written: readonly string[];
  readonly drifted: readonly string[];
}

function stripJsoncLineComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function readJsoncObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8");
  const parsed: unknown = JSON.parse(stripJsoncLineComments(raw));
  return isRecord(parsed) ? parsed : {};
}

function renderMcodeRules(repositoryRoot: string): string {
  const rulesDirectory = path.join(repositoryRoot, ".rulesync", "rules");
  if (!existsSync(rulesDirectory)) return "# AutoDev Rules\n";
  const entries = readdirSync(rulesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((a, b) => FILE_NAME_COLLATOR.compare(a.name, b.name));
  if (entries.length === 0) return "# AutoDev Rules\n";
  const sections = entries.map((entry) =>
    readFileSync(path.join(rulesDirectory, entry.name), "utf8").trim()
  );
  return `${sections.filter(Boolean).join("\n\n---\n\n")}\n`;
}

function resolveTargetMcpServers(
  mcpDocument: Record<string, unknown>
): Record<string, unknown> {
  const base = isRecord(mcpDocument.mcpServers)
    ? { ...mcpDocument.mcpServers }
    : {};
  const mcodeSection = isRecord(mcpDocument.mcode) ? mcpDocument.mcode : null;
  const overrides =
    mcodeSection && isRecord(mcodeSection.mcpServers)
      ? mcodeSection.mcpServers
      : {};
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete base[name];
    else base[name] = value;
  }
  return base;
}

function resolveTargetHooks(
  hooksDocument: Record<string, unknown>
): Record<string, unknown> {
  const base = isRecord(hooksDocument.hooks) ? { ...hooksDocument.hooks } : {};
  const mcodeSection = isRecord(hooksDocument.mcode)
    ? hooksDocument.mcode
    : null;
  const overrides =
    mcodeSection && isRecord(mcodeSection.hooks) ? mcodeSection.hooks : {};
  return { ...base, ...overrides };
}

/*
Render the exact file contents `mcode` expects from canonical `.rulesync/`.
*/
export function renderMcodeProjection(
  repositoryRoot: string
): McodeProjectionFiles {
  const rulesyncRoot = path.join(repositoryRoot, ".rulesync");
  const mcpDocument = readJsoncObject(path.join(rulesyncRoot, "mcp.jsonc"));
  const hooksDocument = readJsoncObject(path.join(rulesyncRoot, "hooks.jsonc"));
  const permissionsDocument = readJsoncObject(
    path.join(rulesyncRoot, "permissions.jsonc")
  );

  const mcodeServers = resolveTargetMcpServers(mcpDocument);
  const mcodeHooks = resolveTargetHooks(hooksDocument);
  const mcodePermissions = isRecord(permissionsDocument.permission)
    ? permissionsDocument.permission
    : {};

  return {
    agentsMd: renderMcodeRules(repositoryRoot),
    mcpJson: `${JSON.stringify({ mcpServers: mcodeServers }, null, 2)}\n`,
    hooksJson: `${JSON.stringify({ hooks: mcodeHooks }, null, 2)}\n`,
    permissionsJson: `${JSON.stringify({ permission: mcodePermissions }, null, 2)}\n`
  };
}

/*
Materialize or verify (`check: true`) the `mcode` projection under `mcodeHome`.
*/
export function materializeMcodeProjection(options: {
  readonly repositoryRoot: string;
  readonly mcodeHome: string;
  readonly check?: boolean;
}): McodeProjectionResult {
  const rendered = renderMcodeProjection(options.repositoryRoot);
  const targets: ReadonlyArray<readonly [string, string]> = [
    [path.join(options.mcodeHome, "AGENTS.md"), rendered.agentsMd],
    [path.join(options.mcodeHome, "mcp.json"), rendered.mcpJson],
    [path.join(options.mcodeHome, "hooks.json"), rendered.hooksJson],
    [path.join(options.mcodeHome, "permissions.json"), rendered.permissionsJson]
  ];

  const written: string[] = [];
  const drifted: string[] = [];

  for (const [filePath, expected] of targets) {
    const current = existsSync(filePath)
      ? readFileSync(filePath, "utf8")
      : null;
    if (current === expected) continue;
    if (options.check) {
      drifted.push(filePath);
      continue;
    }
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    atomicWriteSync(filePath, expected, { mode: 0o600 });
    written.push(filePath);
  }

  if (options.check && drifted.length > 0) {
    throw new Error(
      `mcode RuleSync projection out of date: ${drifted.join(", ")}`
    );
  }

  return {
    mcodeHome: options.mcodeHome,
    written,
    drifted
  };
}
