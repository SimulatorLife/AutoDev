import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderAgentDirectory } from "../config/render-agent-configs.ts";
import { runBridgeMcpCatalogue } from "../config/render-bridge-mcp-catalogue.ts";
import {
  renderExecutionContract,
  runExecutionContract
} from "../config/render-execution-contract.ts";
import { runModelCatalog } from "../config/render-model-catalog.ts";
import { ConfigError, parseArgs, requiredArg } from "../config/toml.ts";
import { writeErrorLine, writeLine } from "../shared/output.ts";
import { dispatchHookCommand, type HookCommandBackend } from "./hook.ts";
import {
  dispatchInstallCommand,
  type InstallCommandBackend
} from "./install.ts";
import {
  dispatchProviderCommand,
  type ProviderCommandBackend
} from "./provider.ts";
import { dispatchRouterCommand, type RouterCommandBackend } from "./router.ts";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url))
);
const defaults = {
  agents: path.join(repoRoot, "agents/roles"),
  prompts: path.join(repoRoot, "agents/prompts"),
  mcp: path.join(repoRoot, "config/config.autodev.toml"),
  rootConfig: path.join(repoRoot, "config/config.autodev.toml"),
  contract: path.join(repoRoot, "config/execution-contract.json")
};

function parseVersionParts(value: string): number[] {
  return value
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part) || 0);
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parseVersionParts(actual);
  const [mMajor = 0, mMinor = 0, mPatch = 0] = parseVersionParts(minimum);
  return (
    aMajor > mMajor ||
    (aMajor === mMajor &&
      (aMinor > mMinor || (aMinor === mMinor && aPatch >= mPatch)))
  );
}

function assertPath(target: string, label: string): void {
  if (!existsSync(target))
    throw new ConfigError(`${label} is missing: ${target}`);
}

function checkRepository(): number {
  if (!versionAtLeast(process.versions.node, "24.12.0"))
    throw new ConfigError(
      `Node 24.12.0 or newer is required; found ${process.versions.node}`
    );
  for (const [label, target] of [
    ["agent sources", defaults.agents],
    ["prompt sources", defaults.prompts],
    ["execution contract", defaults.contract],
    ["portable configuration", defaults.rootConfig]
  ] as const)
    assertPath(target, label);
  execFileSync("git", ["diff", "--check"], { cwd: repoRoot, stdio: "ignore" });
  writeLine(`AutoDev check passed on Node ${process.versions.node}`);
  return 0;
}

function checkRenderedFiles(
  sourceDir: string,
  promptDir: string,
  outputDir: string,
  mcpSource: string
): number {
  if (!existsSync(outputDir)) {
    writeErrorLine(`agent render output is missing: ${outputDir}`);
    return 1;
  }
  const temporary = mkdtempSync(path.join(outputDir, ".autodev-render-check-"));
  try {
    const expected = renderAgentDirectory(
      sourceDir,
      promptDir,
      temporary,
      mcpSource
    );
    for (const source of expected) {
      const target = path.join(outputDir, source.slice(temporary.length + 1));
      if (
        !existsSync(target) ||
        readFileSync(source, "utf8") !== readFileSync(target, "utf8")
      ) {
        writeErrorLine(`agent render drift detected: ${target}`);
        return 1;
      }
    }
    writeLine(`agent render check passed for ${expected.length} role files`);
    return 0;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function renderCommand(kind: string, argv: string[]): number {
  const { values, flags } = parseArgs(argv);
  if (kind === "agents") {
    const sourceDir = values["source-dir"] ?? defaults.agents;
    const promptDir = values["prompt-dir"] ?? defaults.prompts;
    const mcpSource = requiredArg(values, "mcp-source");
    const outputDir = requiredArg(values, "output-dir");
    return flags.has("check")
      ? checkRenderedFiles(sourceDir, promptDir, outputDir, mcpSource)
      : (renderAgentDirectory(sourceDir, promptDir, outputDir, mcpSource), 0);
  }
  if (kind === "contract") {
    const sourceDir = values["source-dir"] ?? defaults.agents;
    const rootConfig = values["root-config"] ?? defaults.rootConfig;
    const contract = values.contract ?? defaults.contract;
    const output = requiredArg(values, "output");
    if (flags.has("check")) {
      const expected = `${JSON.stringify(renderExecutionContract(sourceDir, rootConfig, contract), null, 2)}\n`;
      if (!existsSync(output) || readFileSync(output, "utf8") !== expected) {
        writeErrorLine(`execution contract drift detected: ${output}`);
        return 1;
      }
      writeLine(`execution contract check passed: ${output}`);
      return 0;
    }
    return runExecutionContract(sourceDir, rootConfig, contract, output);
  }
  if (kind === "mcp") {
    const source = requiredArg(values, "mcp-source");
    const output = requiredArg(values, "output");
    return runBridgeMcpCatalogue(source, output, flags.has("check"));
  }
  if (kind === "catalog") {
    const routing = requiredArg(values, "routing-config");
    const catalogsDir = requiredArg(values, "catalogs-dir");
    const output = requiredArg(values, "output");
    return runModelCatalog(routing, catalogsDir, output, flags.has("check"));
  }
  throw new ConfigError(`unsupported render target: ${kind}`);
}

function usage(): void {
  writeLine(
    `Usage: node src/cli/autodev.ts <command> [subcommand] [options]\n\nCommands:\n  check\n  render agents|contract|mcp|catalog\n  router run|ensure|status\n  provider <name>\n  hook <name>\n  install\n`
  );
}

export interface CliBackends {
  router?: RouterCommandBackend;
  provider?: ProviderCommandBackend;
  hook?: HookCommandBackend;
  install?: InstallCommandBackend;
}

export function main(
  argv = process.argv.slice(2),
  backends: CliBackends = {}
): number {
  return runMain(argv, backends);
}

export function runMain(argv: string[], backends: CliBackends = {}): number {
  const [command, subcommand, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  if (command === "check") return checkRepository();
  if (command === "render" && subcommand)
    return renderCommand(subcommand, rest);
  if (command === "router") {
    if (rest.length > 0)
      throw new ConfigError(
        "router commands do not accept positional arguments"
      );
    return dispatchRouterCommand(subcommand ?? "", backends.router);
  }
  if (command === "provider") {
    if (rest.length > 0)
      throw new ConfigError(
        "provider commands do not accept positional arguments"
      );
    return dispatchProviderCommand(subcommand ?? "", backends.provider);
  }
  if (command === "hook") {
    if (rest.length > 0)
      throw new ConfigError("hook commands do not accept positional arguments");
    return dispatchHookCommand(subcommand ?? "", backends.hook);
  }
  if (command === "install") {
    const args = [subcommand, ...rest].filter(
      (value): value is string => value !== undefined
    );
    return dispatchInstallCommand(backends.install, args);
  }
  throw new ConfigError(
    `command '${[command, subcommand].filter(Boolean).join(" ")}' is not implemented in this migration slice; use a typed render/check command or complete the owning subsystem migration`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    writeErrorLine(
      `autodev: ${error instanceof Error ? error.message : error}`
    );
    process.exitCode = 2;
  }
}
