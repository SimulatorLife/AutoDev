import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
}

/**
 * Hermetic homes holding what an install materializes for the provider
 * bridges, generated from `.rulesync/mcp.jsonc` exactly as the installer does:
 * the bridge MCP catalogue under CODEX_HOME and the user-level Copilot MCP file
 * under COPILOT_HOME.
 */
export function createBridgeMcpHomes() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "autodev-bridge-mcp-")));
  const rulesync = join(REPO_ROOT, "node_modules", ".bin", "rulesync");
  const source = join(REPO_ROOT, ".rulesync");
  const projection = join(root, "projection");
  run(rulesync, [ "generate", "--input-roots", source, "--targets", "codexcli", "--features", "mcp", "--output-roots", projection, "--silent" ]);
  const codexHome = join(root, "codex");
  const catalogue = join(codexHome, "provider-runtime", "mcp-servers.json");
  run("python3", [ join(REPO_ROOT, "scripts/codex/render-bridge-mcp-catalogue.py"), "--mcp-source", join(projection, ".codex", "config.toml"), "--output", catalogue ]);
  const home = join(root, "home");
  mkdirSync(home);
  run(rulesync, [ "generate", "--global", "--input-roots", source, "--targets", "copilotcli", "--features", "mcp", "--silent" ], { ...process.env, HOME: home });
  return { root, codexHome, catalogue, copilotHome: join(home, ".copilot") };
}
