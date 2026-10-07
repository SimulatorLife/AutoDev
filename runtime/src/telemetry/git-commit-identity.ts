/**
 * The git identity AutoDev agents commit under.
 *
 * Attribution has to survive where it is least convenient to reconstruct: the
 * commit itself. A Runtime-side session-boundary read cannot tell which actor
 * made a commit -- subagents share one workspace, so the commit stream is a
 * single line with no per-actor markers, and there is no `subagentEnd`
 * boundary to read a range against. Git, however, already stores a committer
 * on every commit, so an agent that commits under a distinguishable identity
 * makes the attribution source-confirmed rather than inferred.
 *
 * Everything here is deliberately bounded. The identity is a fixed local
 * domain plus an allowlisted role and provider; it never carries a session id,
 * a model id, a path, a URL, or any free text, because a commit is permanent
 * and may be pushed. Out-of-allowlist values collapse to `other` rather than
 * being written verbatim.
 */

import { safeAutoDevAgentRole } from "./resource-context/index.ts";

const IDENTITY_DOMAIN = "agents.autodev.local";
const IDENTITY_NAME_PREFIX = "AutoDev Agent";
const OTHER_LABEL = "other";
const AGENT_ROLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/**
 * The same bounded provider vocabulary the rest of the telemetry uses.
 *
 * A provider outside it is not written into a commit; it becomes `other`.
 */
const KNOWN_PROVIDERS = new Set([
  "antigravity",
  "claude",
  "claude-code",
  "codex",
  "copilot",
  "gemini",
  "minimax",
  "openai",
  "qwen"
]);

export interface GitCommitActor {
  readonly role: string;
  readonly provider: string;
}

function boundedRole(value: unknown): string | null {
  const role = safeAutoDevAgentRole(value);
  if (!role) return null;
  const normalized = role.toLowerCase();
  return AGENT_ROLE_PATTERN.test(normalized) ? normalized : null;
}

function boundedProvider(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(normalized)) return null;
  return KNOWN_PROVIDERS.has(normalized) ? normalized : OTHER_LABEL;
}

/**
 * The identity an agent should commit under, or `null` when the actor is not
 * knowable.
 *
 * A role is required. Without one the commit carries no AutoDev identity at
 * all, which is the correct outcome: it stays the user's commit rather than
 * becoming a fabricated agent commit attributed to nobody in particular.
 */
export function gitCommitIdentity(options: {
  readonly role?: unknown;
  readonly provider?: unknown;
}): { readonly name: string; readonly email: string } | null {
  const role = boundedRole(options.role);
  if (!role) return null;
  const provider = boundedProvider(options.provider) ?? OTHER_LABEL;
  return {
    name: `${IDENTITY_NAME_PREFIX} (${role})`,
    email: `autodev-${role}-${provider}@${IDENTITY_DOMAIN}`
  };
}

/**
 * Environment that makes the agent's `git commit` carry that identity.
 *
 * Set rather than written into repo config, so nothing is persisted to the
 * workspace and the operator's own commits are unaffected: git only uses
 * these for a process whose environment carries them.
 */
export function gitCommitIdentityEnv(options: {
  readonly role?: unknown;
  readonly provider?: unknown;
}): Record<string, string> {
  const identity = gitCommitIdentity(options);
  if (!identity) return {};
  return {
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    // The agent writes the code it commits, so it is also the author. Setting
    // only the committer would leave the author as the human operating the
    // console, which would misattribute authorship of the same work.
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email
  };
}

const IDENTITY_EMAIL_PATTERN =
  /^autodev-([a-z0-9-]+?)-([a-z0-9-]+)@agents\.autodev\.local$/u;

/**
 * Recover the actor from a commit's committer identity.
 *
 * Returns `null` for a commit made by a human or by a tool that is not
 * AutoDev: those commits are not agent output, and treating them as
 * unattributed agent work would be the same mistake as guessing an actor.
 */
export function gitCommitActorFromEmail(
  email: string | null | undefined
): GitCommitActor | null {
  if (typeof email !== "string") return null;
  const match = IDENTITY_EMAIL_PATTERN.exec(email.trim().toLowerCase());
  if (!match) return null;
  const [, role, provider] = match;
  if (!role || !provider) return null;
  return { role, provider };
}

/** Whether a committer identity belongs to an AutoDev agent. */
export function isAutoDevGitIdentity(
  email: string | null | undefined
): boolean {
  return gitCommitActorFromEmail(email) !== null;
}
