import { createHash } from "node:crypto";

/**
 * The trust hashes Codex requires for the hooks it is asked to run.
 *
 * Codex hashes each hook *definition* -- the event, the matcher and the
 * handler -- into a normalized identity and refuses to run a hook whose stored
 * hash is not that hash. A hook with no stored hash is untrusted, and a hook
 * whose stored hash no longer matches its definition is "modified"; both are
 * skipped silently, so an installer that keeps its own table of hashes turns
 * a declaration change into hooks that quietly stop running.
 *
 * The hash is therefore computed here from the same definition Codex reads,
 * the way Codex computes it: the identity is serialized as canonical JSON --
 * object keys sorted, no whitespace -- and hashed with SHA-256. This mirrors
 * Codex's `hook_hash`/`version_for_toml` pair, so the installer writes the
 * hash Codex will compare against instead of a copy of one that has drifted.
 *
 * The identity is the declaration's, so this module owns no configuration of
 * its own: the hooks file Codex is given is the input.
 *
 * Codex hashes the command of the platform it runs on, and AutoDev installs on
 * macOS and Linux, where that is the declared `command`.
 */

/** Codex's key label for every event it can discover. */
const EVENT_LABELS: Readonly<Record<string, string>> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  PreModelRequest: "pre_model_request",
  PostModelRequest: "post_model_request",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt"
};

/**
 * The events whose matcher never reaches the identity.
 *
 * A prompt event matches on the prompt, not on a tool name, so Codex drops
 * the matcher before it hashes the hook.
 */
const MATCHERLESS_EVENTS: ReadonlySet<string> = new Set([
  "PreModelRequest",
  "PostModelRequest",
  "UserPromptSubmit",
  "Stop",
  "Interrupt"
]);

/** The timeout Codex gives a hook that declares none. */
const DEFAULT_TIMEOUT_SEC = 600;
/** The timeout Codex gives a SessionEnd or Interrupt hook that declares none. */
const SESSION_END_DEFAULT_TIMEOUT_SEC = 1;
/** The longest timeout Codex keeps for a SessionEnd or Interrupt hook. */
const SESSION_END_MAX_TIMEOUT_SEC = 3;
/** The spill threshold Codex drops from the identity because it is the default. */
const DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT = 2500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The timeout Codex normalizes a declared timeout to. */
function normalizedTimeoutSec(
  event: string,
  declared: number | undefined
): number {
  if (event === "SessionEnd" || event === "Interrupt") {
    const timeout = declared ?? SESSION_END_DEFAULT_TIMEOUT_SEC;
    return Math.min(Math.max(timeout, 1), SESSION_END_MAX_TIMEOUT_SEC);
  }
  return Math.max(declared ?? DEFAULT_TIMEOUT_SEC, 1);
}

/**
 * The identity Codex hashes for one command hook.
 *
 * A field Codex does not carry into the identity is absent rather than null:
 * the identity passes through TOML, which has no null, so an absent field and
 * a null field are the same document.
 */
function hookIdentity(
  event: string,
  matcher: string | undefined,
  handler: Record<string, unknown>
): Record<string, unknown> {
  const identityHandler: Record<string, unknown> = {
    type: "command",
    command: typeof handler.command === "string" ? handler.command : "",
    timeout: normalizedTimeoutSec(
      event,
      typeof handler.timeout === "number" ? handler.timeout : undefined
    ),
    async: handler.async === true
  };
  if (typeof handler.statusMessage === "string") {
    identityHandler.statusMessage = handler.statusMessage;
  }
  if (handler.onFailure === "block" || handler.onFailure === "continue") {
    identityHandler.onFailure = handler.onFailure;
  }
  if (
    typeof handler.additionalContextLimit === "number" &&
    handler.additionalContextLimit !== DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT
  ) {
    identityHandler.additionalContextLimit = handler.additionalContextLimit;
  }
  const identity: Record<string, unknown> = {
    event_name: EVENT_LABELS[event],
    hooks: [identityHandler]
  };
  if (matcher !== undefined) identity.matcher = matcher;
  return identity;
}

/** The object with every key sorted, which is how Codex serializes it. */
function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareByCodeUnit))
      sorted[key] = sortedValue(value[key]);
    return sorted;
  }
  return value;
}

/** The ordering Codex's canonical JSON uses: by code unit, not by locale. */
function compareByCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The hash Codex computes for one hook identity. */
export function codexHookTrustHash(identity: unknown): string {
  const canonical = JSON.stringify(sortedValue(identity));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** One hook's trust entry: the key Codex files it under, and its hash. */
export interface CodexHookTrustEntry {
  /** The trust key suffix: `<event>:<group index>:<handler index>`. */
  readonly key: string;
  readonly hash: string;
}

/**
 * The trust entries for the hooks in a Codex hooks file.
 *
 * The file is the projection Codex is given, so the entries are exactly the
 * hooks it will discover. A handler this module cannot hash is an error
 * rather than a silently untrusted hook.
 */
export function codexHookTrustEntries(
  hooksJson: unknown
): CodexHookTrustEntry[] {
  const entries: CodexHookTrustEntry[] = [];
  const hooks =
    isRecord(hooksJson) && isRecord(hooksJson.hooks) ? hooksJson.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    const label = EVENT_LABELS[event];
    if (label === undefined || !Array.isArray(groups)) continue;
    for (const [groupIndex, group] of groups.entries()) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      const matcher = matcherForEvent(event, group);
      for (const [handlerIndex, handler] of group.hooks.entries()) {
        if (!isRecord(handler) || handler.type !== "command") {
          throw new Error(
            `unsupported Codex hook handler at ${event}:${groupIndex}:${handlerIndex}`
          );
        }
        entries.push({
          key: `${label}:${groupIndex}:${handlerIndex}`,
          hash: codexHookTrustHash(hookIdentity(event, matcher, handler))
        });
      }
    }
  }
  return entries;
}

/**
 * The matcher the identity carries.
 *
 * A prompt event matches on the prompt, not on a tool name, so Codex drops
 * the matcher before it hashes the hook.
 */
function matcherForEvent(
  event: string,
  group: Record<string, unknown>
): string | undefined {
  const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
  return MATCHERLESS_EVENTS.has(event) ? undefined : matcher;
}
