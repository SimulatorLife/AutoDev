/**
 * The delegation call a provider CLI's model can actually make.
 *
 * A CLI bridge's child agents are invisible to Codex: the CLI spawns them
 * inside its own runtime, no Codex thread is created, and the app has nothing
 * to render. The bridge's answer is the `autodev_spawn` MCP server -- the
 * bridge injects it, the CLI's model asks the bridge through it, and the
 * bridge turns the request into Codex's own spawn, so the child becomes a
 * real session the app shows and the router counts.
 *
 * How the model reaches that server is the CLI's own surface, and the shared
 * prompt cannot state it. Antigravity reaches every MCP server through a
 * single `call_mcp_tool` built-in, so a tool is named twice -- server and
 * tool -- with the arguments as one JSON object. The Copilot CLI advertises
 * each MCP tool directly, so the model calls one name. The bridge that owns
 * the surface states the call; this module is the one place that knows how to
 * say it.
 */

import {
  AUTODEV_SPAWN_BARE_TOOL,
  MCP_SERVER_AUTODEV_SPAWN
} from "@simulatorlife/autodev-runtime/shared/tool-names";

/**
 * How one CLI's model names and calls an MCP tool.
 *
 * `dispatcher` is for a CLI with a single built-in that reaches every MCP
 * server: the tool is named twice and the arguments travel as one object.
 * `direct` is for a CLI that advertises each MCP tool on its own: the tool
 * carries one name and the arguments are that tool's own arguments.
 */
export type McpToolReach =
  | { kind: "dispatcher"; dispatcher: string }
  | { kind: "direct"; prefix: string };

/** The arguments one delegation call carries: the children to create. */
const CHILDREN_ARGUMENT = {
  children: [
    {
      agent_type: "<role>",
      message: "<full task>"
    }
  ]
};

function delegationCall(reach: McpToolReach): string {
  if (reach.kind === "dispatcher")
    return JSON.stringify(
      {
        ServerName: MCP_SERVER_AUTODEV_SPAWN,
        ToolName: AUTODEV_SPAWN_BARE_TOOL,
        Arguments: CHILDREN_ARGUMENT
      },
      null,
      2
    );
  return JSON.stringify(CHILDREN_ARGUMENT, null, 2);
}

/**
 * The instruction a bridged orchestrator reads instead of Codex's own
 * `multi_agent_v1__*` functions.
 *
 * The shared prompt names those functions, because on Codex they are the
 * canonical surface. On a CLI they are three inferences away -- the `exec`
 * cell, its `tools` global, and a namespaced name -- and the catalogue that
 * declares their signatures is truncated to its first line behind a pointer
 * to a section only some bridges publish. The bridge's spawn server needs
 * one name and one call, and the bridge that owns the surface is the one that
 * knows both.
 *
 * The section is published for exactly the turns the bridge may delegate in --
 * the ones whose spawn server it registered -- because a turn told to
 * delegate through a server it does not have would report a delegation
 * failure that is not one.
 */
export function bridgeDelegationInstruction(options: {
  /** Whether this turn's bridge holds delegation state for it. */
  mayDelegate: boolean;
  /** How this CLI's model names and calls an MCP tool. */
  reach: McpToolReach;
}): string {
  if (!options.mayDelegate) return "";
  const reach = options.reach;
  const how =
    reach.kind === "dispatcher"
      ? `Call the \`${AUTODEV_SPAWN_BARE_TOOL}\` tool of the \`${MCP_SERVER_AUTODEV_SPAWN}\` MCP server through your \`${reach.dispatcher}\` dispatcher, with these arguments:`
      : `Call the \`${reach.prefix}${MCP_SERVER_AUTODEV_SPAWN}__${AUTODEV_SPAWN_BARE_TOOL}\` tool with these arguments:`;
  return [
    "## Delegation on this provider",
    "This turn runs inside a provider CLI, so the bridge's spawn server is the delegation surface here. Delegate with the call below: the bridge collects the children and asks Codex to create them, so each one is a real Codex session -- the app shows it in the thread and the router counts it -- and the bridge, not you, writes the spawn script.",
    how,
    "```json",
    delegationCall(reach),
    "```",
    "One call may carry a whole batch of children in `children`; each child needs the full context it needs, because a child cannot see this conversation."
  ].join("\n\n");
}
