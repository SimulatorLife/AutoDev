import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runRulesyncGenerate } from "./runtime-files.ts";

const PERMISSIONS_SOURCE_RELATIVE = path.join(".rulesync", "permissions.jsonc");
const PROJECTED_CODEX_CONFIG_RELATIVE = path.join(".codex", "config.toml");
const PROJECTED_CODEX_RULES_RELATIVE = path.join(
  ".codex",
  "rules",
  "rulesync.rules"
);

export interface CodexPermissionsProjection {
  readonly root: string;
  readonly configSource: string;
  readonly rulesSource: string;
}

/*
Project `.rulesync/permissions.jsonc` into Codex CLI's `config.toml` and
`rules/rulesync.rules` inside a temporary directory. Callers own removing
`root` after consuming `configSource` and `rulesSource`.
*/
export function createCodexPermissionsSource(
  repositoryRoot: string
): CodexPermissionsProjection {
  const sourceDirectory = path.join(repositoryRoot, ".rulesync");
  const sourceFile = path.join(repositoryRoot, PERMISSIONS_SOURCE_RELATIVE);
  if (!existsSync(sourceFile)) {
    throw new Error(
      `Missing canonical RuleSync permissions file: ${sourceFile}`
    );
  }
  const root = mkdtempSync(path.join(tmpdir(), "autodev-codex-permissions-"));
  try {
    runRulesyncGenerate(
      repositoryRoot,
      {
        global: true,
        inputRoots: [sourceDirectory],
        targets: ["codexcli"],
        features: ["permissions"],
        silent: true
      },
      root
    );
    const configSource = path.join(root, PROJECTED_CODEX_CONFIG_RELATIVE);
    if (!existsSync(configSource)) {
      throw new Error(
        `RuleSync did not produce projected Codex config at ${configSource}`
      );
    }
    const rulesSource = path.join(root, PROJECTED_CODEX_RULES_RELATIVE);
    if (!existsSync(rulesSource)) {
      throw new Error(
        `RuleSync did not produce projected Codex rules at ${rulesSource}`
      );
    }
    return { root, configSource, rulesSource };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
