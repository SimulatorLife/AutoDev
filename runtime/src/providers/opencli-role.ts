/**
 * OpenCLI's role execution contract.
 *
 * OpenCLI is an execution transport, not a capability or permission boundary.
 * An opencli-backed provider serves every role whose MCP surface the site can
 * natively reach, through the same shared Supergateway that every other
 * provider uses: the site selects the role's MCP app in the conversation, so
 * the conversation's tool surface is the role's canonical contract and the
 * coordinator that owns its delegated children is that role's own.
 *
 * The site never sees a translated tool-call protocol. The prompt states which
 * role the model acts as and that the role's MCP app is the only surface it
 * may act through; the model then calls the app's native MCP tools, exactly
 * as it would in a hand-written ChatGPT conversation.
 */

import { execa } from "execa";

import {
  OPENCLI_PROVIDER_SITES,
  opencliModel,
  type OpencliProvider,
  type OpencliSite
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

import {
  geminiConversationId,
  OpencliCommandError,
  parseOpencliOutput,
  replyFromRow
} from "./opencli-turn.ts";

/** The default number of seconds a role turn may run before it is abandoned. */
export const DEFAULT_OPENCLI_TURN_TIMEOUT_SECONDS = 300;

/**
 * The role whose site-native GitHub connection replaces an MCP `github`
 * server. Every other role's MCP surface reaches AutoDev through the shared
 * gateway's app for that role.
 */
export const GITHUB_WORKER_ROLE = "github-worker";

/** Whether a provider is driven through an opencli site rather than ACP. */
export function isOpencliProvider(
  provider: string
): provider is OpencliProvider {
  return Object.hasOwn(OPENCLI_PROVIDER_SITES, provider);
}

/** The site an opencli provider drives. */
export function opencliProviderSite(provider: string): OpencliSite | null {
  return isOpencliProvider(provider)
    ? OPENCLI_PROVIDER_SITES[provider]
    : null;
}

export interface OpencliRoleTaskSpec {
  readonly role: string;
  readonly provider: OpencliProvider;
  readonly site: OpencliSite;
  readonly model: string;
  readonly sessionId: string;
  /** The site's own conversation identity, pinned after the first turn. */
  readonly conversationId: string | null;
  readonly workspace: string;
  readonly repository: string | null;
  /**
   * The site's MCP app that carries this role's tool surface, or null when
   * the site has no native MCP ingress for the role.
   */
  readonly mcpApp: string | null;
  readonly prompt: string;
  readonly timeoutSeconds: number;
}

export interface OpencliRunResult {
  readonly outputText: string;
  readonly exitCode: number;
  readonly conversationId: string;
}

export type OpencliRunner = (
  task: OpencliRoleTaskSpec,
  signal?: AbortSignal
) => Promise<OpencliRunResult>;

/**
 * Compose the prompt one site-driven role turn sends.
 *
 * The role's canonical system prompt owns the behaviour; this adds only the
 * two facts the site cannot know on its own — which repository the task is
 * about, and which surface the model may act through.
 */
export function composeOpencliRolePrompt(options: {
  readonly role: string;
  readonly systemPrompt: string;
  readonly task: string;
  readonly repository: string | null;
  readonly mcpApp: string | null;
}): string {
  const sections: string[] = [];
  const systemPrompt = options.systemPrompt.trim();
  if (systemPrompt) sections.push(systemPrompt);
  if (options.repository) {
    sections.push(`Repository: ${options.repository}`);
  }
  if (options.role === GITHUB_WORKER_ROLE) {
    sections.push(
      "You are AutoDev's `github-worker` subagent. Use your connected GitHub integration/tools directly to complete the full multi-step GitHub task below autonomously:",
      "",
      "Report the exact resulting pull request/issue URL, branch name, and final status. Never fabricate repository changes or URLs."
    );
  } else if (options.mcpApp) {
    sections.push(
      `Act only through the "${options.mcpApp}" app's tools. They are the only surface that can read or change this workspace, and they are already scoped to your role. Do not describe a tool result you did not receive, and do not invent file paths, URLs, or identifiers.`
    );
  }
  sections.push("", options.task.trim());
  return sections.join("\n");
}

/** Build the task one site-driven role turn executes. */
export function buildOpencliRoleTaskSpec(options: {
  readonly role: string;
  readonly provider: OpencliProvider;
  readonly model: string;
  readonly sessionId: string;
  readonly conversationId?: string | null;
  readonly workspace: string;
  readonly repository?: string | null;
  readonly mcpApp?: string | null;
  readonly systemPrompt: string;
  readonly task: string;
  readonly timeoutSeconds?: number;
}): OpencliRoleTaskSpec {
  return {
    role: options.role,
    provider: options.provider,
    site: OPENCLI_PROVIDER_SITES[options.provider],
    model: options.model,
    sessionId: options.sessionId,
    conversationId: options.conversationId ?? null,
    workspace: options.workspace,
    repository: options.repository ?? null,
    mcpApp: options.mcpApp ?? null,
    prompt: composeOpencliRolePrompt({
      role: options.role,
      systemPrompt: options.systemPrompt,
      task: options.task,
      repository: options.repository ?? null,
      mcpApp: options.mcpApp ?? null
    }),
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_OPENCLI_TURN_TIMEOUT_SECONDS
  };
}

function opencliCommand(): string {
  return process.env.OPENCLI_BIN?.trim() || "opencli";
}

/**
 * Run one site-driven role turn.
 *
 * The site command is the native opencli entry point for the provider's site:
 * ChatGPT's `ask` and Gemini's `ask` both continue a pinned conversation and
 * return the site's own conversation identity, which the Runtime pins to the
 * AutoDev session so follow-up turns continue the same conversation.
 */
export async function runOpencliRoleTurn(
  task: OpencliRoleTaskSpec,
  signal?: AbortSignal
): Promise<OpencliRunResult> {
  const parsed = opencliModel(task.model);
  if (!parsed || parsed.provider !== task.provider) {
    throw new OpencliCommandError(
      "OpenCLI model does not match the pinned provider.",
      "INVALID_OUTPUT",
      null
    );
  }
  const commandArguments = [
    task.site,
    "ask",
    task.prompt,
    ...(task.site === "gemini" ? ["--model", parsed.siteModel] : []),
    ...(task.mcpApp ? ["--app", task.mcpApp] : []),
    ...(task.conversationId
      ? ["--conversation", task.conversationId]
      : ["--new", "true"]),
    "--timeout",
    String(task.timeoutSeconds),
    "-f",
    "json"
  ];

  const result = await execa(opencliCommand(), commandArguments, {
    stdin: "ignore",
    reject: false,
    ...(signal ? { cancelSignal: signal } : {})
  });
  const output = result.stdout.trim();
  const errorText = result.stderr.trim();
  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) {
    throw new OpencliCommandError(
      errorText || output || `opencli exited with code ${exitCode}`,
      "COMMAND_EXEC",
      exitCode
    );
  }
  const row = parseOpencliOutput(output, exitCode)[0];
  if (!row) throw new OpencliCommandError("OpenCLI returned no response row.", "INVALID_OUTPUT", null);
  const reply = replyFromRow(row);
  const conversationId =
    task.site === "gemini" ? geminiConversationId(row.url) : reply.conversationId;
  if (!conversationId) {
    throw new OpencliCommandError(
      "OpenCLI response has no verifiable conversation identity.",
      "INVALID_OUTPUT",
      null
    );
  }
  return { outputText: reply.response, exitCode, conversationId };
}
