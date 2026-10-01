export type UsageVariableId =
  | "workspace"
  | "provider"
  | "model"
  | "agent"
  | "skill";

export interface UsageVariable {
  readonly id: UsageVariableId;
  readonly label: string;
  readonly signal: "traces" | "metrics";
  readonly scope: "resource" | "span";
  readonly key: string;
  readonly multi: boolean;
  readonly supportsAll: boolean;
  readonly defaultValues?: readonly string[];
}

export type UsageWidgetId =
  | "logical-requests"
  | "requests-by-agent"
  | "tokens"
  | "cache-rate"
  | "p95-latency"
  | "attempts-by-provider"
  | "mcp-calls"
  | "mcp-duration"
  | "mcp-errors"
  | "mcp-by-tool";

export interface UsageWidgetConfig {
  readonly id: UsageWidgetId;
  readonly title: string;
  readonly description?: string;
  readonly optInVariables: readonly UsageVariableId[];
  readonly variableScopeOverrides?: Partial<Record<UsageVariableId, "resource" | "span">>;
}
