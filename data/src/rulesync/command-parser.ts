import { createHash } from "node:crypto";

import type { PromptAsset } from "@simulatorlife/autodev-core";
import { parse as parseYaml } from "yaml";

/**
 * The canonical RuleSync command parser.
 *
 * It is its own module because it is a pure function of a command's text, and
 * because it is read by more than the repository: the Console previews the
 * source an operator has not saved yet, and it has to answer with the same
 * parser the Runtime validates a write with. A reader that asked its own
 * front-matter question would be a second answer to the same question, and
 * the preview and the save could then disagree about the same text.
 *
 * Nothing here resolves a path on disk. The repository's own module reads the
 * working tree and resolves the repository root through the module URL, which
 * a bundler cannot follow -- so the parser, which needs no path, does not
 * carry one.
 */

export const COMMANDS_SOURCE = ".rulesync/commands" as const;

const COMMAND_FRONTMATTER_PATTERN =
  /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u;

export interface RuleSyncCommand extends PromptAsset {
  readonly name: string;
  readonly path: string;
  readonly kind: "command";
  readonly content: string;
  readonly prompt: string;
  readonly targets: readonly string[];
  readonly revision: string;
}

export class RuleSyncCommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSyncCommandValidationError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses a canonical RuleSync command from its source.
 *
 * The front matter is read here and nowhere else, so a reader of the
 * command's body and a writer of the command agree on what the command says.
 */
export function parseRuleSyncCommand(
  name: string,
  content: string
): RuleSyncCommand {
  const frontmatter = content.match(COMMAND_FRONTMATTER_PATTERN);
  if (!frontmatter) {
    throw new RuleSyncCommandValidationError(
      `Command "${name}" must have valid YAML frontmatter.`
    );
  }
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter[1]!);
  } catch {
    throw new RuleSyncCommandValidationError(
      `Command "${name}" frontmatter is invalid YAML.`
    );
  }
  if (!isRecord(metadata)) {
    throw new RuleSyncCommandValidationError(
      `Command "${name}" frontmatter must be a mapping.`
    );
  }
  const description = metadata.description;
  const targets = metadata.targets ?? ["*"];
  if (
    (description !== undefined && typeof description !== "string") ||
    !Array.isArray(targets) ||
    !targets.every((target) => typeof target === "string") ||
    (metadata.name !== undefined && metadata.name !== name)
  ) {
    throw new RuleSyncCommandValidationError(
      `Command "${name}" frontmatter metadata is invalid.`
    );
  }
  return {
    name,
    path: `${COMMANDS_SOURCE}/${name}.md`,
    kind: "command",
    content,
    prompt: frontmatter[2]?.trim() ?? "",
    targets,
    revision: createHash("sha256").update(content, "utf8").digest("hex"),
    ...(description === undefined ? {} : { description })
  };
}
