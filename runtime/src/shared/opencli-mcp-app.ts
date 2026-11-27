/**
The site's MCP app that carries one AutoDev role's tool surface.

The shared gateway publishes a role-scoped endpoint per role, and the site
reaches each one through the connector the operator installed for it. The
connector's display name is what the site's own UI shows and what the
transport selects, so AutoDev defines the name and the operator installs
the connector under it.
*/

/**
The base name every role's app name is derived from.
*/
export const CHATGPT_MCP_APP_BASE_ENV = "AUTODEV_CHATGPT_MCP_APP_BASE";
/**
One explicit app name, used for every role.
*/
export const CHATGPT_MCP_APP_ENV = "AUTODEV_CHATGPT_MCP_APP";
/**
The role whose app keeps the bare base name.
*/
export const DEFAULT_CHATGPT_MCP_APP_ROLE = "orchestrator";
export const DEFAULT_CHATGPT_MCP_APP_BASE = "AutoDev";

/**
The app name for a role.

An explicit `AUTODEV_CHATGPT_MCP_APP` wins for every role, because one
connector can only ever reach one endpoint: an operator who serves a
single role should not have to keep the role in the name.
*/
export function resolveChatgptMcpApp(
  role: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const explicit = environment[CHATGPT_MCP_APP_ENV]?.trim();
  if (explicit) return explicit;
  const base =
    environment[CHATGPT_MCP_APP_BASE_ENV]?.trim() ||
    DEFAULT_CHATGPT_MCP_APP_BASE;
  const normalized = role.trim().toLowerCase();
  return normalized === DEFAULT_CHATGPT_MCP_APP_ROLE
    ? base
    : `${base} ${normalized}`;
}
