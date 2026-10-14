import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import { resolveConsolePort } from "../console-ensure.ts";
import { resolveServiceNode } from "../host-arch.ts";

/** The install-wide paths every service LaunchAgent template is rendered against. */
export interface LaunchAgentPaths {
  readonly repositoryRoot: string;
  readonly home: string;
  readonly codexHome: string;
}

export interface LaunchAgentValues {
  readonly codexHome: string;
  readonly home: string;
  readonly repositoryRoot: string;
  /** The Node binary services run on; see resolveServiceNode. */
  readonly nodeBin: string;
  /** The loopback port the Console binds; see resolveConsolePort. */
  readonly consolePort: string;
}

const PLACEHOLDER_PATTERN = /__[A-Z0-9_]+__/gu;

/**
 * Build the single value set every service LaunchAgent renders from. Both the
 * installer and `install check` derive their values here so a template cannot
 * render one way during install and be verified another way.
 */
export function resolveLaunchAgentValues(
  paths: LaunchAgentPaths,
  env: NodeJS.ProcessEnv = process.env
): LaunchAgentValues {
  return {
    codexHome: paths.codexHome,
    home: paths.home,
    repositoryRoot: paths.repositoryRoot,
    nodeBin: resolveServiceNode(paths.home),
    consolePort: String(resolveConsolePort(env.AUTODEV_CONSOLE_PORT))
  };
}

function renderedTemplate(
  templatePath: string,
  template: string,
  values: LaunchAgentValues
): string {
  const rendered = template
    .replaceAll("__CODEX_HOME__", () => values.codexHome)
    .replaceAll("__HOME__", () => values.home)
    .replaceAll("__AUTODEV_REPO_ROOT__", () => values.repositoryRoot)
    .replaceAll("__AUTODEV_NODE_BIN__", () => values.nodeBin)
    .replaceAll("__AUTODEV_CONSOLE_PORT__", () => values.consolePort);
  const unresolved = rendered.match(PLACEHOLDER_PATTERN);
  // An unrendered placeholder is not a cosmetic defect: it ships verbatim into
  // a launchd job, where the service dies on its first command line. Refuse to
  // render rather than hand launchd a template we only partly understand.
  if (unresolved)
    throw new Error(
      `${templatePath} leaves ${unresolved.join(", ")} unresolved; render it from LaunchAgentValues or remove it from the template.`
    );
  return rendered;
}

export function renderLaunchAgent(
  templatePath: string,
  targetPath: string,
  values: LaunchAgentValues
): void {
  const content = renderedTemplate(
    templatePath,
    readFileSync(templatePath, "utf8"),
    values
  );
  const directory = path.dirname(targetPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.autodev-launchagent-${randomBytes(8).toString("hex")}.plist`
  );
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o644 });
    chmodSync(temporary, 0o644);
    renameSync(temporary, targetPath);
    chmodSync(targetPath, 0o644);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* already renamed */
    }
  }
}

export function launchAgentMatches(
  templatePath: string,
  targetPath: string,
  values: LaunchAgentValues
): boolean {
  try {
    return (
      existsSync(targetPath) &&
      readFileSync(targetPath, "utf8") ===
        renderedTemplate(
          templatePath,
          readFileSync(templatePath, "utf8"),
          values
        )
    );
  } catch {
    // An unrenderable template reports as drift, so `install check` asks for a
    // re-render instead of certifying a file it could not fully resolve.
    return false;
  }
}

const USAGE =
  "usage: launchagent render|check <template> <target> <codex-home> <home> <repository-root> <node-bin> <console-port>";

function parseLaunchAgentValues(argv: string[]): LaunchAgentValues {
  const [codexHome, home, repositoryRoot, nodeBin, consolePort] = argv;
  if (!codexHome || !home || !repositoryRoot || !nodeBin || !consolePort)
    throw new Error(USAGE);
  return {
    codexHome,
    home,
    repositoryRoot,
    nodeBin,
    consolePort: String(resolveConsolePort(consolePort))
  };
}

function cli(argv: string[]): number {
  const [command, template, target, ...rest] = argv;
  if ((command !== "render" && command !== "check") || !template || !target)
    throw new Error(USAGE);
  const replacement = parseLaunchAgentValues(rest);
  if (command === "render") renderLaunchAgent(template, target, replacement);
  else if (!launchAgentMatches(template, target, replacement)) return 1;
  return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    writeErrorLine(
      `launchagent: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
