import type { AgentRole } from "../agents/types.ts";

export interface McpServerConfig {
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly defaultToolsApprovalMode?: string;
}

export interface McpTool {
  readonly name: string;
  readonly server: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly server: string;
  readonly mimeType?: string;
}

export interface McpPrompt {
  readonly name: string;
  readonly server: string;
  readonly description?: string;
}

export interface McpRoleExposure {
  readonly server: string;
  readonly roles: readonly AgentRole[];
  readonly tools?: readonly McpTool[];
}
