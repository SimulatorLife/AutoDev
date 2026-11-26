import { isRecord } from "@simulatorlife/autodev-core";
import { parse as parseYaml } from "yaml";

/** RuleSync targets are a list of names; RuleSync owns target-name validation. */
export function isRuleSyncTargetList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((target) => typeof target === "string")
  );
}

const FRONTMATTER_PATTERN =
  /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u;

export type RuleSyncFrontmatter =
  | {
      readonly kind: "valid";
      readonly metadata: Record<string, unknown>;
      readonly body: string;
    }
  | { readonly kind: "missing" | "invalid_yaml" | "not_mapping" };

/**
 * Decode canonical RuleSync Markdown using the existing YAML parser.
 * Document-specific validation and error wording belong to the caller.
 */
export function parseRuleSyncFrontmatter(content: string): RuleSyncFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) return { kind: "missing" };
  let metadata: unknown;
  try {
    metadata = parseYaml(match[1]!);
  } catch {
    return { kind: "invalid_yaml" };
  }
  if (!isRecord(metadata)) return { kind: "not_mapping" };
  return { kind: "valid", metadata, body: match[2] ?? "" };
}
