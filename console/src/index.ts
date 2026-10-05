/**
 * Public Console component/utility surface.
 *
 * Navigation is URL-addressable: every internal link is a `ConsoleLink`
 * (a Next.js `Link`, i.e. a real `<a href>`) so the App Router swaps only the
 * page segment while the root-layout shell persists. Active-section state is
 * derived from the route, never from local section-switching state.
 */

export * from "./components/cards/StatCard.ts";
export * from "./components/layout/AppShell.ts";
export * from "./components/navigation/ActiveSection.ts";
export * from "./components/navigation/AppNav.ts";
export * from "./components/navigation/Breadcrumbs.ts";
export * from "./components/navigation/ConsoleForm.ts";
export * from "./components/navigation/ConsoleLink.ts";
export * from "./components/navigation/PendingSpinner.ts";
export * from "./components/status/StatusBadge.ts";
export * from "./components/tables/DataTable.ts";
export * from "./components/tabs/Tabs.ts";
export * from "./features/agents/AgentDetailView.ts";
export * from "./features/agents/AgentsView.ts";
export * from "./features/evaluations/EvaluationsView.ts";
export * from "./features/github/GithubView.ts";
export * from "./features/hooks/HooksView.ts";
export * from "./features/mcps/McpDetailView.ts";
export * from "./features/mcps/McpsView.ts";
export * from "./features/memory/MemoryCohortsView.ts";
export * from "./features/memory/MemoryExperiencesView.ts";
export * from "./features/memory/MemoryPortalCard.ts";
export * from "./features/memory/MemoryRecordsView.ts";
export * from "./features/memory/MemorySummary.ts";
export * from "./features/memory/MemorySummaryStream.ts";
export * from "./features/memory/MemoryView.ts";
export * from "./features/permissions/PermissionsView.ts";
export * from "./features/prompts/PromptDetailView.ts";
export * from "./features/prompts/PromptsView.ts";
export * from "./features/skills/SkillsView.ts";
export * from "./features/tools/ToolsView.ts";
export * from "./features/usage/UsageView.ts";
export * from "./features/workspaces/WorkspacesView.ts";
