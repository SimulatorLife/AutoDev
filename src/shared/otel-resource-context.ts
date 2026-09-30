const ATTR_VALUE_MAX_LENGTH = 64;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const URI_VALUE_PATTERN = /^(?:file|https?):\/\//iu;
const AGENT_ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const AUTODEV_WORKSPACE_KEY_HEADER = "x-autodev-workspace-key";
export const OTEL_RESOURCE_ATTRIBUTES_ENV = "OTEL_RESOURCE_ATTRIBUTES";

const AUTODEV_WORKSPACE_ATTRIBUTE = "autodev.workspace";
const AUTODEV_AGENT_ROLE_ATTRIBUTE = "autodev.agent.role";

/** Validate an opaque workspace key without accepting a filesystem path or URL. */
export function safeAutoDevWorkspaceKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (
    !key ||
    key.length > ATTR_VALUE_MAX_LENGTH ||
    key.toLowerCase() === "unknown" ||
    key.toLowerCase() === "unattributed" ||
    key.startsWith("/") ||
    key.startsWith("~") ||
    key.includes("\\") ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(key) ||
    URI_VALUE_PATTERN.test(key)
  ) {
    return null;
  }
  return key;
}

/** Validate bounded agent-role context before it becomes telemetry metadata. */
export function safeAutoDevAgentRole(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const role = value.trim();
  if (
    !role ||
    !AGENT_ROLE_PATTERN.test(role) ||
    ["unknown", "unattributed", "unattributed-subagent"].includes(
      role.toLowerCase()
    )
  ) {
    return null;
  }
  return role;
}

/**
 * Clone a child process environment and attach only validated per-request
 * AutoDev resource identity. Existing non-AutoDev resource attributes are
 * preserved; stale workspace/role values are replaced or removed so a reused
 * parent environment cannot misattribute a later turn.
 */
export function withAutoDevOtelResourceContext(
  environment: NodeJS.ProcessEnv,
  workspace: unknown,
  role: unknown
): NodeJS.ProcessEnv {
  const additions = new Map<string, string>();
  const safeWorkspace = safeAutoDevWorkspaceKey(workspace);
  const safeRole = safeAutoDevAgentRole(role);
  if (safeWorkspace) additions.set(AUTODEV_WORKSPACE_ATTRIBUTE, safeWorkspace);
  if (safeRole) additions.set(AUTODEV_AGENT_ROLE_ATTRIBUTE, safeRole);

  const current = environment[OTEL_RESOURCE_ATTRIBUTES_ENV] ?? "";
  const reserved = new Set([
    AUTODEV_WORKSPACE_ATTRIBUTE,
    AUTODEV_AGENT_ROLE_ATTRIBUTE
  ]);
  const preserved = current.split(",").filter((attribute) => {
    if (!attribute.trim()) return false;
    const separator = attribute.indexOf("=");
    if (separator === -1) return true;
    return !reserved.has(attribute.slice(0, separator).trim());
  });
  const next = [
    ...preserved,
    ...Array.from(
      additions,
      ([key, value]) => `${key}=${encodeURIComponent(value)}`
    )
  ].join(",");

  if (next === current) return environment;
  const result = { ...environment };
  if (next) result[OTEL_RESOURCE_ATTRIBUTES_ENV] = next;
  else delete result[OTEL_RESOURCE_ATTRIBUTES_ENV];
  return result;
}

/**
 * Return only validated AutoDev identity attributes for a child MCP process.
 * Other resource attributes can contain unrelated local configuration and are
 * intentionally not copied into the MCP server command configuration.
 */
export function validatedAutoDevOtelResourceAttributes(
  environment: NodeJS.ProcessEnv
): string | null {
  const source = environment[OTEL_RESOURCE_ATTRIBUTES_ENV];
  if (!source) return null;

  const validators: Record<string, (value: string) => string | null> = {
    [AUTODEV_WORKSPACE_ATTRIBUTE]: safeAutoDevWorkspaceKey,
    [AUTODEV_AGENT_ROLE_ATTRIBUTE]: safeAutoDevAgentRole
  };
  const values = new Map<string, string | null>();
  for (const attribute of source.split(",")) {
    const separator = attribute.indexOf("=");
    if (separator <= 0) continue;
    const key = attribute.slice(0, separator).trim();
    const validate = validators[key];
    if (!validate) continue;
    let value: string | null;
    try {
      value = decodeURIComponent(attribute.slice(separator + 1).trim());
    } catch {
      value = null;
    }
    values.set(key, value === null ? null : validate(value));
  }

  return (
    [AUTODEV_WORKSPACE_ATTRIBUTE, AUTODEV_AGENT_ROLE_ATTRIBUTE]
      .flatMap((key) => {
        const value = values.get(key);
        return value ? [`${key}=${encodeURIComponent(value)}`] : [];
      })
      .join(",") || null
  );
}
