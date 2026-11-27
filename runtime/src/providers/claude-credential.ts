/**
The Claude Code account credential the Runtime uses for provider-owned
model discovery.

The Anthropic model listing authenticates with the account's own OAuth
token, so the Runtime learns the models the signed-in account can actually
run instead of a static catalog. The token is the one the Claude Code
bridge already authenticates its turns with, and it lives either in the
environment or in the owner-only keychain item the bridge writes.
*/
import { readKeychainSecret } from "@simulatorlife/autodev-runtime/shared/runtime-secrets";

const KEYCHAIN_SERVICE = "com.codex.claude-bridge.oauth-token";

/**
The Claude Code account's OAuth token, or an empty string when absent.
*/
export function readClaudeOAuthToken(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const direct = environment.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (direct) return direct;
  return (
    readKeychainSecret(KEYCHAIN_SERVICE, environment, { exactAccount: true }) ?? ""
  );
}

/**
Forward the existing Claude Code OAuth token only to the quota-axi child
environment so its read-only Claude quota request can authenticate. The
child report does not contain the token.
*/
export function claudeQuotaAxiEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const token = readClaudeOAuthToken(baseEnvironment);
  if (!token) return { ...baseEnvironment };
  return {
    ...baseEnvironment,
    CLAUDE_CODE_OAUTH_TOKEN: token
  };
}
