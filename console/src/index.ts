/**
 * Public Console component/utility surface.
 *
 * The URL-addressable shell components are server-renderable and use native
 * anchor links. The legacy client-side section-switching wrapper was removed.
 */

export * from "./components/cards/StatCard.ts";
export * from "./components/layout/AppShell.ts";
export * from "./components/navigation/AppNav.ts";
export * from "./components/navigation/Breadcrumbs.ts";
export * from "./components/status/ControlFailureNotice.ts";
export * from "./components/status/ConvergenceBadge.ts";
export * from "./components/status/StatusBadge.ts";
export * from "./components/tables/Chips.ts";
export * from "./components/tables/DataTable.ts";
export * from "./components/tabs/Tabs.ts";
export * from "./features/agents/AgentDetailView.ts";
export * from "./features/agents/AgentProviderSummary.ts";
export * from "./features/agents/AgentsView.ts";
export * from "./features/evaluations/EvaluationsView.ts";
export * from "./features/github/GithubView.ts";
export * from "./features/hooks/HooksView.ts";
export * from "./features/mcps/McpDetailView.ts";
export * from "./features/mcps/McpsView.ts";
export * from "./features/memory/MemoryCohortsView.ts";
export * from "./features/memory/MemoryExperiencesView.ts";
export * from "./features/memory/MemoryRecordsView.ts";
export * from "./features/memory/MemoryView.ts";
export * from "./features/permissions/PermissionsView.ts";
export * from "./features/prompts/PromptDetailView.ts";
export * from "./features/prompts/PromptsView.ts";
export * from "./features/providers/EnablementToggle.ts";
export * from "./features/providers/ModelDetailView.ts";
export * from "./features/providers/paths.ts";
export * from "./features/providers/provider-status.ts";
export * from "./features/providers/ProviderDetailView.ts";
export * from "./features/providers/ProvidersView.ts";
export * from "./features/skills/SkillsView.ts";
export * from "./features/tools/tool-identity.ts";
export * from "./features/tools/tool-usage.ts";
export * from "./features/tools/ToolDetailView.ts";
export * from "./features/tools/ToolsView.ts";
export * from "./features/usage/UsageView.ts";
export * from "./features/workspaces/WorkspacesView.ts";
export * from "./lib/control-failure.ts";
