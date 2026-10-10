import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConfigError,
  parseArgs,
  renderAgentDirectory,
  renderExecutionContract,
  requiredArg,
  runBridgeMcpCatalogue,
  runExecutionContract,
  runModelCatalog
} from "@simulatorlife/autodev-runtime/config";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import { unsupportedChoice } from "./command-choice.ts";
import {
  dispatchHookCommand,
  HOOK_NAMES,
  type HookCommandBackend
} from "./hook.ts";
import {
  dispatchInstallCommand,
  type InstallCommandBackend
} from "./install.ts";
import {
  dispatchProviderCommand,
  PROVIDER_NAMES,
  type ProviderCommandBackend
} from "./provider.ts";
import {
  dispatchRepoCommand,
  REPO_SUBCOMMANDS,
  type RepoCommandBackend
} from "./repo.ts";
import {
  dispatchRouterCommand,
  ROUTER_COMMANDS,
  type RouterCommandBackend
} from "./router.ts";

/**
 * The render vocabulary, owned here and consumed by validation, help, and
 * errors. The dispatch is a `switch` over these values rather than a narrowing
 * guard, so this list is what `default` rejects against.
 */
export const RENDER_TARGETS = ["agents", "contract", "mcp", "catalog"] as const;

const repoRoot = path.resolve(resolveRuntimeSourceRoot(import.meta.dirname));
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

/**
 * Runs one render target.
 *
 * Every target `RENDER_TARGETS` declares is handled here, and `default` is the
 * single place an unusable one is rejected -- including the empty string from
 * `autodev render` with no target, which is why the command no longer needs a
 * guard above the switch. Keeping one rejection site means the accepted values
 * cannot be listed in one message and validated in another.
 *
 * `tests/cli/command-usage.test.ts` is what holds the three lists together: it
 * walks the `--help` output and drives every value advertised there through
 * dispatch, so adding a target to `RENDER_TARGETS` without handling it here
 * fails the suite instead of silently falling through to `default`.
 */
function renderCommand(kind: string, argv: string[]): number {
  const { values, flags } = parseArgs(argv);
  switch (kind) {
    case "agents": {
      const sourceDir = values["source-dir"] ?? defaults.agents;
      const promptDir = values["prompt-dir"] ?? defaults.prompts;
      const mcpSource = requiredArg(values, "mcp-source");
      const outputDir = requiredArg(values, "output-dir");
      return flags.has("check")
        ? checkRenderedFiles(sourceDir, promptDir, outputDir, mcpSource)
        : (renderAgentDirectory(sourceDir, promptDir, outputDir, mcpSource), 0);
    }
    case "contract": {
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
    case "mcp": {
      const source = requiredArg(values, "mcp-source");
      const output = requiredArg(values, "output");
      return runBridgeMcpCatalogue(source, output, flags.has("check"));
    }
    case "catalog": {
      const routing = requiredArg(values, "routing-config");
      const catalogsDir = requiredArg(values, "catalogs-dir");
      const output = requiredArg(values, "output");
      return runModelCatalog(routing, catalogsDir, output, flags.has("check"));
    }
    default: {
      throw unsupportedChoice("render target", kind, RENDER_TARGETS);
    }
  }
}

/**
 * The command families `--help` advertises, in the order it lists them, each
 * paired with the values its subcommand accepts.
 *
 * Assembled from the same lists the dispatchers validate against. It used to
 * be one string literal with the subcommands typed out a second time, so
 * nothing connected the help to the validators: a command could be advertised
 * here and rejected there, which is exactly how `render` ended up described as
 * unimplemented while `--help` listed it. `render`, `router`, `provider`,
 * `hook`, and `repo` now expand their alternatives automatically, so the two
 * families whose values were previously undiscoverable -- `provider` and
 * `hook` -- name what they accept instead of showing a bare `<name>`, and
 * reading `--help` is enough rather than running a command to fail.
 */
const COMMAND_ROWS: readonly (readonly [string, string])[] = [
  ["check", ""],
  ["render", RENDER_TARGETS.join("|")],
  ["router", ROUTER_COMMANDS.join("|")],
  ["provider", PROVIDER_NAMES.join("|")],
  ["hook", HOOK_NAMES.join("|")],
  ["repo", REPO_SUBCOMMANDS.join("|")],
  ["install", ""]
];

const RENDER_ARGUMENTS: Record<
  (typeof RENDER_TARGETS)[number],
  { readonly required: string; readonly optional: string }
> = {
  agents: {
    required: "--mcp-source <toml> --output-dir <dir>",
    optional: "[--source-dir <dir>] [--prompt-dir <dir>] [--check]"
  },
  contract: {
    required: "--output <file>",
    optional:
      "[--source-dir <dir>] [--root-config <file>] [--contract <file>] [--check]"
  },
  mcp: {
    required: "--mcp-source <toml> --output <file>",
    optional: "[--check]"
  },
  catalog: {
    required: "--routing-config <file> --catalogs-dir <dir> --output <file>",
    optional: "[--check]"
  }
};

function usage(): void {
  writeLine(
    [
      "Usage: pnpm autodev -- <command> [subcommand] [options]",
      "",
      "Commands:",
      ...COMMAND_ROWS.map(
        ([name, choices]) =>
          `  ${name}${choices.length > 0 ? ` ${choices}` : ""}`
      ),
      "",
      'Render target arguments (after "render"):',
      "    Bracketed options are optional; --check verifies generated output.",
      "    --mcp-source expects Codex TOML generated from the RuleSync MCP catalog.",
      ...RENDER_TARGETS.flatMap((target) => {
        const { required, optional } = RENDER_ARGUMENTS[target];
        return [`    ${target} ${required}`, `      ${optional}`];
      }),
      "    Defaults (checkout-relative): --source-dir agents/roles,",
      "      --prompt-dir agents/prompts, --root-config config/config.autodev.toml,",
      "      --contract config/execution-contract.json.",
      ""
    ].join("\n")
  );
}

export interface CliBackends {
  router?: RouterCommandBackend;
  provider?: ProviderCommandBackend;
  hook?: HookCommandBackend;
  repo?: RepoCommandBackend;
  install?: InstallCommandBackend;
}

export function runMain(
  argv: string[] = process.argv.slice(2),
  backends: CliBackends = {}
): number | Promise<number> {
  // pnpm forwards its argument separator to the script; it is not a command.
  const [command, subcommand, ...rest] =
    argv[0] === "--" ? argv.slice(1) : argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  if (command === "check") return checkRepository();
  // No `&& subcommand` guard: a family invoked bare must reach its own
  // validation so it can name the values it accepts, rather than falling
  // through to the unknown-command branch below and being reported as a command
  // that does not exist.
  if (command === "render") return renderCommand(subcommand ?? "", rest);
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
  if (command === "repo") {
    return dispatchRepoCommand(subcommand ?? "", rest, backends.repo);
  }
  if (command === "install") {
    const args = [subcommand, ...rest].filter(
      (value): value is string => value !== undefined
    );
    return dispatchInstallCommand(backends.install, args);
  }
  throw unsupportedChoice(
    "command",
    command,
    COMMAND_ROWS.map(([name]) => name)
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runMain();
  } catch (error) {
    writeErrorLine(
      `autodev: ${error instanceof Error ? error.message : error}`
    );
    process.exitCode = 2;
  }
}
