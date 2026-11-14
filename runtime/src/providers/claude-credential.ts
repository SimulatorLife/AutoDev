/**
 * The Claude Code account credential the Runtime uses for provider-owned
 * model discovery.
 *
 * The Anthropic model listing authenticates with the account's own OAuth
 * token, so the Runtime learns the models the signed-in account can actually
 * run instead of a static catalog. The token is the one the Claude Code
 * bridge already authenticates its turns with, and it lives either in the
 * environment or in the owner-only keychain item the bridge writes.
 */
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

const KEYCHAIN_SERVICE = "com.codex.claude-bridge.oauth-token";

/** The Keychain item account; launchd may omit USER and inherit LOGNAME=root. */
export function claudeKeychainAccount(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.USER?.trim() || userInfo().username;
}

function keychainToken(env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        claudeKeychainAccount(env),
        "-s",
        KEYCHAIN_SERVICE,
        "-w"
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000
      }
    ).trim();
  } catch {
    return "";
  }
}

/** The Claude Code account's OAuth token, or an empty string when absent. */
export function readClaudeOAuthToken(
  env: NodeJS.ProcessEnv = process.env
): string {
  const direct = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (direct) return direct;
  return keychainToken(env);
}

/**
 * Forward the existing Claude Code OAuth token only to the quota-axi child
 * environment so its read-only Claude quota request can authenticate. The
 * child report does not contain the token.
 */
export function claudeQuotaAxiEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const token = readClaudeOAuthToken(baseEnv);
  if (!token) return { ...baseEnv };
  return {
    ...baseEnv,
    CLAUDE_CODE_OAUTH_TOKEN: token
  };
}
