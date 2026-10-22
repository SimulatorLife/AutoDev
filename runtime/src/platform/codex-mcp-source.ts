import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { ConfigError } from "@simulatorlife/autodev-runtime/config";

import { runRulesyncGenerate } from "./runtime-files.ts";

/**
 * The Codex MCP projection of the canonical declaration.
 *
 * `root` is the throwaway directory RuleSync generated into and `source` is
 * the generated Codex configuration inside it. The caller owns `root` and has
 * to remove it when it is done with the projection.
 *
 * This lives in its own module because two owners need it -- the installer and
 * the Control API's MCP mutation -- and the installer and the Control API
 * already depend on each other, so a shared projection cannot live in either
 * of them without a cycle.
 */
export function createCodexMcpSource(repositoryRoot: string): {
  root: string;
  source: string;
} {
  const root = mkdtempSync(
    path.join(process.env.TMPDIR ?? "/tmp", "autodev-codex-mcp-")
  );
  try {
    const rulesync = path.join(
      repositoryRoot,
      "node_modules",
      ".bin",
      "rulesync"
    );
    if (!existsSync(rulesync))
      throw new ConfigError(
        `missing-rulesync ${rulesync}; run pnpm install --frozen-lockfile`
      );
    runRulesyncGenerate(repositoryRoot, {
      inputRoots: [path.join(repositoryRoot, ".rulesync")],
      targets: ["codexcli"],
      features: ["mcp"],
      outputRoots: [root],
      silent: true
    });
    const source = path.join(root, ".codex", "config.toml");
    if (!existsSync(source))
      throw new ConfigError(
        `Rulesync did not generate Codex MCP source: ${source}`
      );
    return { root, source };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `could not generate Codex MCP projection: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
