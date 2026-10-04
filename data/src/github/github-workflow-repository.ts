import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  GithubWorkflowCatalogStatus,
  GithubWorkflowDefinition
} from "@simulatorlife/autodev-core";
import { parseDocument } from "yaml";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW_FILE_PATTERN = /\.ya?ml$/u;

export interface GithubWorkflowCatalogRead {
  readonly status: GithubWorkflowCatalogStatus;
  readonly workflows: readonly GithubWorkflowDefinition[];
}

interface ParsedWorkflowTriggers {
  readonly name: string | null;
  readonly events: readonly string[];
  readonly schedules: readonly string[];
}

function isYamlMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map;
}

function eventNamesFrom(value: unknown): readonly string[] | null {
  const values =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value
        : isYamlMap(value)
          ? Array.from(value.keys())
          : null;
  if (!values || values.length === 0) return null;
  if (
    !values.every(
      (event) =>
        typeof event === "string" && event.length > 0 && event.trim() === event
    )
  ) {
    return null;
  }
  return Array.from(new Set(values as string[])).sort();
}

function cronExpressionsFrom(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const expressions: string[] = [];
  for (const entry of value) {
    if (!isYamlMap(entry)) return null;
    const cron = entry.get("cron");
    if (typeof cron !== "string" || cron.trim().length === 0) return null;
    expressions.push(cron);
  }
  return Array.from(new Set(expressions)).sort();
}

/**
 * Parse only the fields needed for the workflow catalog, while delegating YAML
 * syntax and YAML 1.2 key semantics to the maintained `yaml` parser. In
 * particular, YAML 1.2 preserves GitHub's top-level `on` key as a string
 * instead of interpreting it as a YAML 1.1 boolean.
 */
function parseWorkflowTriggers(content: string): ParsedWorkflowTriggers | null {
  try {
    const document = parseDocument(content, {
      version: "1.2",
      uniqueKeys: true
    });
    if (document.errors.length > 0) return null;

    const workflow = document.toJS({ mapAsMap: true });
    if (!isYamlMap(workflow) || !workflow.has("on")) return null;

    const rawName = workflow.get("name");
    if (
      rawName !== undefined &&
      rawName !== null &&
      typeof rawName !== "string"
    ) {
      return null;
    }

    const rawTriggers = workflow.get("on");
    const events = eventNamesFrom(rawTriggers);
    if (!events) return null;

    let schedules: readonly string[] = [];
    if (isYamlMap(rawTriggers) && rawTriggers.has("schedule")) {
      const parsedSchedules = cronExpressionsFrom(rawTriggers.get("schedule"));
      if (!parsedSchedules) return null;
      schedules = parsedSchedules;
    }

    return {
      name: typeof rawName === "string" ? rawName : null,
      events,
      schedules
    };
  } catch {
    return null;
  }
}

export class GithubWorkflowRepository {
  readonly repositoryRoot: string;

  constructor(repositoryRoot: string = DEFAULT_REPO_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  readWorkflowCatalog(): GithubWorkflowCatalogRead {
    const workflowsDir = path.join(this.repositoryRoot, ".github", "workflows");
    let filenames: string[];
    try {
      filenames = readdirSync(workflowsDir)
        .filter((filename) => WORKFLOW_FILE_PATTERN.test(filename))
        .sort();
    } catch {
      return { status: "unavailable", workflows: [] };
    }

    const workflows: GithubWorkflowDefinition[] = [];
    for (const filename of filenames) {
      let content: string;
      try {
        content = readFileSync(path.join(workflowsDir, filename), "utf8");
      } catch {
        return { status: "unavailable", workflows: [] };
      }
      const parsed = parseWorkflowTriggers(content);
      if (parsed === null) return { status: "invalid", workflows: [] };
      workflows.push({
        id: filename,
        name: parsed.name,
        path: `.github/workflows/${filename}`,
        events: parsed.events,
        schedules: parsed.schedules
      });
    }
    return { status: "valid", workflows };
  }
}
