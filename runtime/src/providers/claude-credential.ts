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

const KEYCHAIN_SERVICE = "com.codex.claude-bridge.oauth-token";

function keychainToken(env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        env.USER ?? "",
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
