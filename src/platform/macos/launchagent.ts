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

import { writeErrorLine } from "../../shared/output.ts";

export interface LaunchAgentValues {
  readonly codexHome: string;
  readonly home: string;
  readonly repositoryRoot: string;
}

function renderedTemplate(template: string, values: LaunchAgentValues): string {
  return template
    .replaceAll("__CODEX_HOME__", () => values.codexHome)
    .replaceAll("__HOME__", () => values.home)
    .replaceAll("__AUTODEV_REPO_ROOT__", () => values.repositoryRoot);
}

export function renderLaunchAgent(
  templatePath: string,
  targetPath: string,
  values: LaunchAgentValues
): void {
  const content = renderedTemplate(readFileSync(templatePath, "utf8"), values);
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
        renderedTemplate(readFileSync(templatePath, "utf8"), values)
    );
  } catch {
    return false;
  }
}

function parseLaunchAgentValues(argv: string[]): LaunchAgentValues {
  const [codexHome, home, repositoryRoot] = argv;
  if (!codexHome || !home || !repositoryRoot)
    throw new Error(
      "usage: launchagent render|check <template> <target> <codex-home> <home> <repository-root>"
    );
  return { codexHome, home, repositoryRoot };
}

function cli(argv: string[]): number {
  const [command, template, target, ...rest] = argv;
  if ((command !== "render" && command !== "check") || !template || !target)
    throw new Error(
      "usage: launchagent render|check <template> <target> <codex-home> <home> <repository-root>"
    );
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
