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

import { z } from "zod";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import {
  OPENCLI_PROVIDER_SITES,
  OPENCLI_PROVIDERS,
  opencliModel,
  type OpencliProvider,
  type OpencliSite
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

import {
  answeredIn,
  GEMINI_REPLY_PREFIX,
  GEMINI_THINKING_LEVELS,
  geminiConversationId,
  geminiModelLimit,
  isGeminiModelSelectionFailure,
  isGeminiThinkingSelectionFailure,
  OpencliCommandError,
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
  readonly reasoningEffort?: string | null;
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
  readonly reasoningEffort?: string | null;
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
    reasoningEffort: options.reasoningEffort ?? null,
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

/** Only the trusted Runtime uses this internal, loopback service route. */
export const OPENCLI_ROLE_TURN_PATH = "/internal/role-turn";
export const OPENCLI_ROUTER_AUTH_VARIABLE = "CODEX_ROUTER_OPENCLI_API_KEY";
export const OPENCLI_DEFAULT_PORT = 4004;
const TURN_TRANSPORT_GRACE_MS = 30_000;

export const opencliRoleTurnSchema = z.strictObject({
  role: z.string().min(1).max(128),
  provider: z.enum(OPENCLI_PROVIDERS),
  model: z.string().min(1).max(128),
  reasoningEffort: z.string().min(1).max(64).nullable().optional(),
  conversationId: z.string().regex(/^[\w-]+$/u).max(256).nullable(),
  mcpApp: z.string().min(1).max(256).nullable(),
  prompt: z.string().min(1).max(100_000),
  timeoutSeconds: z.number().int().positive().max(900)
});

type RoleTurn = z.infer<typeof opencliRoleTurnSchema>;
type RunSite = (request: {
  readonly args: readonly string[];
  readonly signal: AbortSignal;
}) => Promise<Record<string, unknown>[]>;

const resultSchema = z.strictObject({
  outputText: z.string(),
  exitCode: z.literal(0),
  conversationId: z.string().min(1)
});
const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: resultSchema }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      message: z.string(),
      code: z.string(),
      exitCode: z.number().int().nullable()
    })
  })
]);

/** Execute the native site command only inside the existing browser owner. */
export async function executeOpencliRoleTurn(
  task: RoleTurn,
  run: RunSite,
  signal: AbortSignal
): Promise<OpencliRunResult> {
  const parsed = opencliModel(task.model);
  if (!parsed || parsed.provider !== task.provider) {
    throw new OpencliCommandError(
      "OpenCLI model does not match the pinned provider.",
      "INVALID_OUTPUT",
      null
    );
  }
  const site = OPENCLI_PROVIDER_SITES[task.provider];
  const baseAskArgs = (
    model: string | null,
    thinking: string | null
  ): string[] => [
    site,
    "ask",
    task.prompt,
    ...(model === null ? [] : ["--model", model]),
    ...(thinking === null ? [] : ["--thinking", thinking]),
    ...(site === "chatgpt" && task.mcpApp ? ["--app", task.mcpApp] : []),
    ...(task.conversationId
      ? ["--conversation", task.conversationId]
      : ["--new", "true"]),
    "--timeout",
    String(task.timeoutSeconds),
    "-f",
    "json"
  ];
  let rows: Record<string, unknown>[];
  if (site === "gemini") {
    const requestedThinking =
      typeof task.reasoningEffort === "string" &&
      GEMINI_THINKING_LEVELS.includes(task.reasoningEffort)
        ? task.reasoningEffort
        : null;
    try {
      rows = await run({
        args: baseAskArgs(parsed.siteModel, requestedThinking),
        signal
      });
    } catch (error) {
      if (requestedThinking !== null && isGeminiThinkingSelectionFailure(error)) {
        writeErrorLine(
          `opencli gemini could not switch to ${requestedThinking}: ${errorMessage(error)}`
        );
        try {
          rows = await run({
            args: baseAskArgs(parsed.siteModel, null),
            signal
          });
        } catch (retryError) {
          if (!isGeminiModelSelectionFailure(retryError)) {
            throw geminiModelLimit(retryError) ?? retryError;
          }
          writeErrorLine(
            `opencli gemini could not switch to ${parsed.siteModel}: ${errorMessage(retryError)}`
          );
          rows = await run({ args: baseAskArgs(null, null), signal });
        }
      } else if (isGeminiModelSelectionFailure(error)) {
        writeErrorLine(
          `opencli gemini could not switch to ${parsed.siteModel}: ${errorMessage(error)}`
        );
        rows = await run({ args: baseAskArgs(null, null), signal });
      } else {
        throw geminiModelLimit(error) ?? error;
      }
    }
  } else {
    rows = await run({
      args: baseAskArgs(parsed.siteModel, null),
      signal
    });
  }
  const row = rows[0];
  if (!row) {
    throw new OpencliCommandError(
      "OpenCLI returned no response row.",
      "INVALID_OUTPUT",
      null
    );
  }
  const reply = replyFromRow(row);
  const rawConversationId =
    site === "gemini" ? geminiConversationId(row.url) : reply.conversationId;
  const outputText =
    site === "gemini" && reply.response.startsWith(GEMINI_REPLY_PREFIX)
      ? reply.response.slice(GEMINI_REPLY_PREFIX.length)
      : reply.response;
  const verified = answeredIn(
    site === "gemini" ? "Gemini" : "ChatGPT",
    task.conversationId,
    {
      response: outputText,
      conversationId: rawConversationId,
      modelSelected: true
    }
  );
  if (!verified.conversationId) {
    throw new OpencliCommandError(
      "OpenCLI response has no verifiable conversation identity.",
      "INVALID_OUTPUT",
      null
    );
  }
  return {
    outputText: verified.response,
    exitCode: 0,
    conversationId: verified.conversationId
  };
}

/**
 * Runtime-side client of the browser owner. No raw argv or arbitrary
 * executable is accepted by the service, and no direct spawn fallback exists.
 */
export async function runOpencliRoleTurn(
  task: OpencliRoleTaskSpec,
  signal?: AbortSignal
): Promise<OpencliRunResult> {
  const token = process.env[OPENCLI_ROUTER_AUTH_VARIABLE]?.trim();
  if (!token) {
    throw new OpencliCommandError(
      "OpenCLI Runtime service credential is missing; reconcile the installer.",
      "AUTH_REQUIRED",
      null
    );
  }
  const host = process.env.CODEX_OPENCLI_PROXY_HOST?.trim() || "127.0.0.1";
  if (!["127.0.0.1", "::1", "[::1]", "localhost"].includes(host)) {
    throw new OpencliCommandError(
      "OpenCLI role execution requires a loopback browser service.",
      "COMMAND_EXEC",
      null
    );
  }
  const port = Number(process.env.CODEX_OPENCLI_PROXY_PORT || OPENCLI_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid OpenCLI service port.");
  }
  const body = opencliRoleTurnSchema.parse({
    role: task.role,
    provider: task.provider,
    model: task.model,
    reasoningEffort: task.reasoningEffort ?? null,
    conversationId: task.conversationId,
    mcpApp: task.mcpApp,
    prompt: task.prompt,
    timeoutSeconds: task.timeoutSeconds
  });
  const deadline = AbortSignal.timeout(
    body.timeoutSeconds * 1000 + TURN_TRANSPORT_GRACE_MS
  );
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const authority = host === "::1" ? "[::1]" : host;
  let response: Response;
  try {
    response = await fetch(`http://${authority}:${port}${OPENCLI_ROLE_TURN_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      redirect: "error",
      body: JSON.stringify(body),
      signal: requestSignal
    });
  } catch {
    throw new OpencliCommandError(
      signal?.aborted
        ? "OpenCLI turn cancelled."
        : deadline.aborted
          ? "OpenCLI browser service turn deadline exceeded."
          : "OpenCLI browser service unavailable; reconcile the installed Runtime.",
      signal?.aborted ? "CANCELLED" : "COMMAND_EXEC",
      null
    );
  }
  const bodyResult: unknown = await response.json().catch(() => null);
  const parsed = responseSchema.safeParse(bodyResult);
  if (!parsed.success) {
    throw new OpencliCommandError(
      `OpenCLI browser service returned an invalid result (HTTP ${response.status}).`,
      "INVALID_OUTPUT",
      null
    );
  }
  if (!parsed.data.ok) {
    const error = parsed.data.error;
    throw new OpencliCommandError(error.message, error.code, error.exitCode);
  }
  if (!response.ok) {
    throw new OpencliCommandError(
      `OpenCLI browser service returned HTTP ${response.status}.`,
      "COMMAND_EXEC",
      null
    );
  }
  return parsed.data.result;
}
