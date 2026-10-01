import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  HookAction,
  HookDefinition,
  HookEvent,
  PromptAsset,
  SkillDefinition
} from "../../../core/src/index.ts";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COLLATOR = new Intl.Collator();
const MD_EXTENSION_PATTERN = /\.md$/u;
const SKILL_DESCRIPTION_PATTERN = /description:\s*([^\n]+)/i;

export class RuleSyncRepository {
  readonly repositoryRoot: string;

  constructor(repositoryRoot: string = DEFAULT_REPO_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  loadCommands(): PromptAsset[] {
    const commandsDir = path.join(this.repositoryRoot, ".rulesync", "commands");
    if (!existsSync(commandsDir)) return [];
    try {
      const files = readdirSync(commandsDir);
      return files
        .filter((file) => file.endsWith(".md"))
        .sort((a, b) => COLLATOR.compare(a, b))
        .map((file) => {
          const name = file.replace(MD_EXTENSION_PATTERN, "");
          const fullPath = path.join(commandsDir, file);
          let content = "";
          try {
            content = readFileSync(fullPath, "utf8");
          } catch {
            // Ignore unreadable file
          }
          return {
            name,
            path: `.rulesync/commands/${file}`,
            description: `RuleSync command ${name}`,
            content
          };
        });
    } catch {
      return [];
    }
  }

  loadHooks(): HookDefinition[] {
    const hooksPath = path.join(this.repositoryRoot, ".rulesync", "hooks.jsonc");
    if (!existsSync(hooksPath)) return [];
    try {
      const raw = JSON.parse(readFileSync(hooksPath, "utf8")) as {
        hooks?: Record<string, HookAction[]>;
      };
      const hooksRecord = raw.hooks ?? {};
      const result: HookDefinition[] = [];
      for (const [event, actions] of Object.entries(hooksRecord)) {
        result.push({
          event: event as HookEvent,
          actions: Array.isArray(actions) ? actions : []
        });
      }
      return result;
    } catch {
      return [];
    }
  }

  loadMcp(): Record<string, unknown> {
    const mcpPath = path.join(this.repositoryRoot, ".rulesync", "mcp.jsonc");
    if (!existsSync(mcpPath)) return {};
    try {
      return JSON.parse(readFileSync(mcpPath, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  loadSkills(): SkillDefinition[] {
    const skillsDir = path.join(this.repositoryRoot, ".rulesync", "skills");
    if (!existsSync(skillsDir)) return [];
    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const name = entry.name;
          const skillMd = path.join(skillsDir, name, "SKILL.md");
          let description = `RuleSync skill ${name}`;
          if (existsSync(skillMd)) {
            try {
              const text = readFileSync(skillMd, "utf8");
              const descMatch = text.match(SKILL_DESCRIPTION_PATTERN);
              if (descMatch?.[1]) description = descMatch[1].trim();
            } catch {
              // Ignore unreadable SKILL.md
            }
          }
          return {
            name,
            description,
            path: `.rulesync/skills/${name}/SKILL.md`
          };
        })
        .sort((a, b) => COLLATOR.compare(a.name, b.name));
    } catch {
      return [];
    }
  }
}
