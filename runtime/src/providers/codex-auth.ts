import { readFile } from "node:fs/promises";

const CODEX_HOME =
  process.env.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`;

/**
 * The Codex auth file the codex route authenticates with. It is resolved per
 * call so a deployment -- or a test -- can point the router at a specific
 * file without restarting the process.
 */
function codexAuthFile(): string {
  return process.env.CODEX_ROUTER_AUTH_FILE ?? `${CODEX_HOME}/auth.json`;
}

export async function loadCodexAuth(): Promise<{
  token: string;
  accountId: string;
}> {
  const file = codexAuthFile();
  const auth = JSON.parse(await readFile(file, "utf8"));
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!token || !accountId)
    throw new Error(
      `Codex auth is missing access_token or account_id in ${file}`
    );
  return { token, accountId };
}
