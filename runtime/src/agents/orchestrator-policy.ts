/**
What the root orchestrator may do with a shell tool.

The root orchestrator plans, delegates, and integrates. Reading the
repository's history is investigation, and investigation belongs to a child
with a scoped brief: a root turn that digs through `git show` and
`git log -p` re-sends every byte of that output with each later request of
the session, and the digging itself is work a child does without growing
the root's context.

The policy refuses the `git` subcommands that read history. Everything else
-- `git status`, `git diff` of the working tree, `git add`, `git commit` --
is integration work the root still does. It is a delegation boundary, not a
security one: a command whose text cannot be read is left alone, because
the root runs in the session's own sandbox and nothing here narrows it.

The same subcommand list drives every surface that runs the root's tools:
the Codex `PreToolUse` hook (Codex-native, Claude, Antigravity, MiniMax and
opencli roots, whose tools Codex executes) and the Copilot bridge's
`--deny-tool` arguments (Copilot runs its own shell tool).
*/

import {
  gitSubcommand,
  isShellToolName,
  normalizeToolName,
  shellCommandFromToolInput,
  shellInterpreterScript,
  splitSegments,
  tokenize
} from "./read-only-policy.ts";

/**
What the policy decided about one root tool call.
*/
export interface OrchestratorDecision {
  readonly allowed: boolean;
  /**
  Why the call was refused, and what to do instead.
  */
  readonly reason: string | null;
}

const ALLOWED: OrchestratorDecision = { allowed: true, reason: null };

/**
The `git` subcommands that read the repository's history rather than its
current state.
*/
export const GIT_HISTORY_SUBCOMMANDS: readonly string[] = [
  "annotate",
  "bisect",
  "blame",
  "cherry",
  "diff-tree",
  "log",
  "range-diff",
  "reflog",
  "rev-list",
  "shortlog",
  "show",
  "whatchanged"
];

const GIT_HISTORY: ReadonlySet<string> = new Set(GIT_HISTORY_SUBCOMMANDS);

/**
The explicit AutoDev orchestrator alias is a restrictive hook-policy signal
for native Codex turns that do not report a role. A concrete provider model
is not a role identifier. Neither the alias nor a hook payload grants
Runtime/MCP authorization; that is enforced independently.
*/
export function isRootOrchestratorModel(model: string): boolean {
  return model === "autodev/orchestrator";
}

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
Commands that run the command that follows them.
*/
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  "builtin",
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "sudo",
  "time",
  "timeout",
  "xargs"
]);

const DURATION = /^\d/u;

/**
The index of the command a segment runs, past env assignments and wrappers.
*/
function wrappedCommandIndex(tokens: readonly string[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    const wrapper = token.slice(token.lastIndexOf("/") + 1);
    if (ENVIRONMENT_ASSIGNMENT.test(token)) {
      index += 1;
      continue;
    }
    if (!COMMAND_WRAPPERS.has(wrapper)) return index;
    index += 1;
    // Wrapper flags and a `timeout` duration precede the wrapped command.
    for (const argument of tokens.slice(index)) {
      const skipped =
        argument.startsWith("-") ||
        (wrapper === "timeout" && DURATION.test(argument));
      if (!skipped) break;
      index += 1;
    }
  }
  return index;
}

/**
The history subcommand a shell segment runs, or null when it runs none.
*/
function historySubcommandOf(segment: string, depth: number): string | null {
  const tokens = tokenize(segment);
  const index = wrappedCommandIndex(tokens);
  const command = tokens[index];
  if (command === undefined) return null;
  const name = command.slice(command.lastIndexOf("/") + 1);
  const arguments_ = tokens.slice(index + 1);
  const script = shellInterpreterScript(name, arguments_);
  if (script !== null)
    return depth >= 2 ? null : historySubcommandIn(script, depth + 1);
  if (name !== "git") return null;
  const subcommand = gitSubcommand(arguments_);
  return subcommand !== undefined && GIT_HISTORY.has(subcommand)
    ? subcommand
    : null;
}

function historySubcommandIn(command: string, depth: number): string | null {
  for (const segment of splitSegments(command)) {
    const found = historySubcommandOf(segment, depth);
    if (found !== null) return found;
  }
  return null;
}

/**
Whether a root orchestrator tool call may run.

Only shell tools are judged; every other tool -- spawning and waiting on
children, MCP lookups, reading a file -- is left alone.
*/
export function evaluateOrchestratorToolCall(input: {
  readonly toolName: string;
  readonly toolInput: unknown;
}): OrchestratorDecision {
  if (!isShellToolName(normalizeToolName(input.toolName))) return ALLOWED;
  const command = shellCommandFromToolInput(input.toolInput);
  if (command === null) return ALLOWED;
  const subcommand = historySubcommandIn(command, 0);
  if (subcommand === null) return ALLOWED;
  return {
    allowed: false,
    reason:
      `The root orchestrator does not read git history (\`git ${subcommand}\`). ` +
      "Work from the code as it is now. If the task is a regression whose cause " +
      "needs history, delegate that investigation to one child with a scoped " +
      "brief (the symptom, the files, a commit range) and have it report the " +
      "finding, not the raw history. For current state or HEAD verification, use " +
      "`git status`, `git diff`, or `git rev-parse --short HEAD`."
  };
}

/**
The Copilot CLI `--deny-tool` arguments that apply the same boundary when
Copilot runs the root's shell itself.
*/
export function copilotOrchestratorDenyToolArgs(): string[] {
  return GIT_HISTORY_SUBCOMMANDS.map(
    (subcommand) => `--deny-tool=shell(git ${subcommand})`
  );
}
