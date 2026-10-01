import React, { useState } from "react";

import { StatCard } from "../../components/cards/StatCard.ts";

export interface UsageMetricsData {
  readonly logicalRequests: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly cacheReadRate: number | null;
  readonly p95LatencyMs: number;
  readonly physicalAttempts: number;
  readonly mcpCalls: number;
  readonly p95McpDurationMs: number;
  readonly mcpErrors: number;
  readonly requestsByRole: readonly { readonly role: string; readonly count: number }[];
  readonly attemptsByProvider: readonly { readonly provider: string; readonly count: number }[];
  readonly callsByTool: readonly { readonly tool: string; readonly count: number }[];
}

export interface UsageViewProps {
  readonly metrics?: UsageMetricsData;
  readonly workspaces?: readonly string[];
  readonly providers?: readonly string[];
  readonly models?: readonly string[];
  readonly roles?: readonly string[];
}

const DEFAULT_METRICS: UsageMetricsData = {
  logicalRequests: 420,
  totalInputTokens: 1_250_000,
  totalOutputTokens: 380_000,
  cacheReadRate: 48.5,
  p95LatencyMs: 1420,
  physicalAttempts: 450,
  mcpCalls: 312,
  p95McpDurationMs: 42,
  mcpErrors: 0,
  requestsByRole: [
    { role: "orchestrator", count: 180 },
    { role: "worker", count: 140 },
    { role: "explorer", count: 65 },
    { role: "smart", count: 35 }
  ],
  attemptsByProvider: [
    { provider: "codex", count: 260 },
    { provider: "claude", count: 120 },
    { provider: "antigravity", count: 45 },
    { provider: "minimax", count: 25 }
  ],
  callsByTool: [
    { tool: "read_file", count: 140 },
    { tool: "exec_command", count: 95 },
    { tool: "lsp_find_symbol", count: 45 },
    { tool: "web_search", count: 32 }
  ]
};

const SELECT_CLASS =
  "bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-slate-200";
const FILTER_GROUP_CLASS = "flex items-center gap-1.5 text-xs text-slate-400";

export function UsageView({
  metrics = DEFAULT_METRICS,
  workspaces = ["All", "SimulatorLife/AutoDev", "SimulatorLife/RacingGame"],
  providers = ["All", "codex", "claude", "antigravity", "copilot", "minimax"],
  models = ["All", "gpt-5.6-terra", "claude-3-5-sonnet", "gemini-1.5-pro"],
  roles = ["All", "orchestrator", "worker", "explorer", "smart"]
}: UsageViewProps): React.JSX.Element {
  const [selectedWorkspace, setSelectedWorkspace] = useState("All");
  const [selectedProvider, setSelectedProvider] = useState("All");
  const [selectedModel, setSelectedModel] = useState("All");
  const [selectedRole, setSelectedRole] = useState("All");

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "usage" },
    React.createElement(
      "div",
      {
        className:
          "bg-slate-900 border border-slate-800 p-4 rounded-lg flex flex-wrap gap-4 items-center justify-between shadow"
      },
      React.createElement(
        "div",
        { className: "flex flex-wrap gap-3 items-center" },
        React.createElement(
          "div",
          { className: FILTER_GROUP_CLASS },
          React.createElement("span", null, "Workspace:"),
          React.createElement(
            "select",
            {
              value: selectedWorkspace,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                setSelectedWorkspace(e.target.value),
              className: SELECT_CLASS
            },
            workspaces.map((w) =>
              React.createElement("option", { key: w, value: w }, w)
            )
          )
        ),
        React.createElement(
          "div",
          { className: FILTER_GROUP_CLASS },
          React.createElement("span", null, "Provider:"),
          React.createElement(
            "select",
            {
              value: selectedProvider,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                setSelectedProvider(e.target.value),
              className: SELECT_CLASS
            },
            providers.map((p) =>
              React.createElement("option", { key: p, value: p }, p)
            )
          )
        ),
        React.createElement(
          "div",
          { className: FILTER_GROUP_CLASS },
          React.createElement("span", null, "Model:"),
          React.createElement(
            "select",
            {
              value: selectedModel,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                setSelectedModel(e.target.value),
              className: SELECT_CLASS
            },
            models.map((m) =>
              React.createElement("option", { key: m, value: m }, m)
            )
          )
        ),
        React.createElement(
          "div",
          { className: FILTER_GROUP_CLASS },
          React.createElement("span", null, "Role:"),
          React.createElement(
            "select",
            {
              value: selectedRole,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                setSelectedRole(e.target.value),
              className: SELECT_CLASS
            },
            roles.map((r) =>
              React.createElement("option", { key: r, value: r }, r)
            )
          )
        )
      ),
      React.createElement(
        "span",
        { className: "text-xs text-slate-500 font-mono" },
        "Last 24 Hours"
      )
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h3",
        {
          className:
            "text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3"
        },
        "Router & GenAI Observability"
      ),
      React.createElement(
        "div",
        {
          className:
            "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"
        },
        React.createElement(StatCard, {
          title: "Logical Routed Requests",
          value: metrics.logicalRequests,
          subtitle: "autodev.routed_request"
        }),
        React.createElement(StatCard, {
          title: "Input / Output Tokens",
          value: `${(metrics.totalInputTokens / 1000).toFixed(0)}k / ${(metrics.totalOutputTokens / 1000).toFixed(0)}k`,
          subtitle: "Physical attempt totals"
        }),
        React.createElement(StatCard, {
          title: "Cache-read Rate",
          value:
            metrics.cacheReadRate === null
              ? "Unavailable"
              : `${metrics.cacheReadRate.toFixed(1)}%`,
          subtitle: "Cached / Input tokens"
        }),
        React.createElement(StatCard, {
          title: "P95 Latency",
          value: `${metrics.p95LatencyMs} ms`,
          subtitle: "Physical attempt duration"
        })
      )
    ),
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-2 gap-6" },
      React.createElement(
        "div",
        {
          className:
            "bg-slate-900 border border-slate-800 rounded-lg p-5 shadow"
        },
        React.createElement(
          "h4",
          {
            className:
              "text-xs font-semibold uppercase text-slate-400 mb-3"
          },
          "Requests by Agent Role"
        ),
        React.createElement(
          "div",
          { className: "flex flex-col gap-2" },
          metrics.requestsByRole.map((item) =>
            React.createElement(
              "div",
              {
                key: item.role,
                className:
                  "flex items-center justify-between text-xs py-1 border-b border-slate-800/60 last:border-none"
              },
              React.createElement(
                "span",
                { className: "font-mono text-slate-200" },
                item.role
              ),
              React.createElement(
                "span",
                { className: "font-semibold text-emerald-400" },
                item.count
              )
            )
          )
        )
      ),
      React.createElement(
        "div",
        {
          className:
            "bg-slate-900 border border-slate-800 rounded-lg p-5 shadow"
        },
        React.createElement(
          "h4",
          {
            className:
              "text-xs font-semibold uppercase text-slate-400 mb-3"
          },
          "Physical Attempts by Provider"
        ),
        React.createElement(
          "div",
          { className: "flex flex-col gap-2" },
          metrics.attemptsByProvider.map((item) =>
            React.createElement(
              "div",
              {
                key: item.provider,
                className:
                  "flex items-center justify-between text-xs py-1 border-b border-slate-800/60 last:border-none"
              },
              React.createElement(
                "span",
                { className: "font-mono text-slate-200" },
                item.provider
              ),
              React.createElement(
                "span",
                { className: "font-semibold text-cyan-400" },
                item.count
              )
            )
          )
        )
      )
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h3",
        {
          className:
            "text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3"
        },
        "Model Context Protocol Shim Metrics"
      ),
      React.createElement(
        "div",
        { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
        React.createElement(StatCard, {
          title: "MCP Tool Calls",
          value: metrics.mcpCalls,
          subtitle: "Shim tools/call round trips"
        }),
        React.createElement(StatCard, {
          title: "P95 Tool-call Duration",
          value: `${metrics.p95McpDurationMs} ms`,
          subtitle: "Shim-owned round trip"
        }),
        React.createElement(StatCard, {
          title: "MCP Tool Errors",
          value: metrics.mcpErrors,
          subtitle: "Errored tools/call spans"
        })
      )
    ),
    React.createElement(
      "div",
      {
        className:
          "bg-slate-900 border border-slate-800 rounded-lg p-5 shadow"
      },
      React.createElement(
        "h4",
        {
          className:
            "text-xs font-semibold uppercase text-slate-400 mb-3"
        },
        "MCP Calls by Tool Name"
      ),
      React.createElement(
        "div",
        { className: "grid grid-cols-2 md:grid-cols-4 gap-4" },
        metrics.callsByTool.map((item) =>
          React.createElement(
            "div",
            {
              key: item.tool,
              className:
                "bg-slate-950 p-3 rounded border border-slate-800 flex flex-col justify-between"
            },
            React.createElement(
              "span",
              {
                className: "text-xs font-mono text-slate-400 truncate"
              },
              item.tool
            ),
            React.createElement(
              "span",
              { className: "text-lg font-bold text-slate-100 mt-1" },
              item.count
            )
          )
        )
      )
    )
  );
}
