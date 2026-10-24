/**
 * Canonical AutoDev Console navigation.
 *
 * The grouping below is the single authoritative definition of the Console
 * resource surface. Configure/Observe/Operate are presentation groups; the
 * 14 resources remain first-class routes. Any flattened section list, route
 * slug lookup, or section-order helper is derived from this definition so
 * membership and order can never diverge between parallel declarations.
 *
 * Authority: docs/autodev-console-target-state.md §2 "Canonical resource
 * surface" — Configure = Agents, Providers, MCPs, Skills, Hooks, Prompts,
 * Permissions, Tools; Observe = Usage, Evaluations, Playtesting, Memory;
 * Operate = Workspaces, GitHub.
 */

export type CanonicalNavGroupId = "Configure" | "Observe" | "Operate";

export interface CanonicalNavGroup<TSection extends string = string> {
  readonly id: CanonicalNavGroupId;
  readonly label: CanonicalNavGroupId;
  readonly description: string;
  readonly sections: readonly TSection[];
}

export const CANONICAL_NAV_GROUPS = [
  {
    id: "Configure",
    label: "Configure",
    description: "Canonical desired state for AutoDev resources.",
    sections: [
      "Agents",
      "Providers",
      "MCPs",
      "Skills",
      "Hooks",
      "Prompts",
      "Permissions",
      "Tools"
    ]
  },
  {
    id: "Observe",
    label: "Observe",
    description:
      "Telemetry, evaluations, playtesting, and historical behavior.",
    sections: ["Usage", "Evaluations", "Playtesting", "Memory"]
  },
  {
    id: "Operate",
    label: "Operate",
    description: "Workspaces and operator workflows.",
    sections: ["Workspaces", "GitHub"]
  }
] as const satisfies readonly CanonicalNavGroup[];

export type CanonicalNavSection =
  (typeof CANONICAL_NAV_GROUPS)[number]["sections"][number];

/**
 * What each canonical resource is for, in one sentence.
 *
 * A resource's purpose belongs to the resource, not to the page that renders
 * it. A page that states its own purpose can state it on the happy path and
 * forget it on the path where the operator most needs to know what they are
 * looking at -- which is how the Playtesting page came to be the one resource
 * whose header named a surface without saying what it owns, and how the
 * detail pages of the other thirteen came to name a resource without saying
 * what it is for either.
 *
 * The sentence lives here, beside the navigation that lists the resource, so
 * there is one answer per resource, no page can have a different one, and a
 * resource added to the navigation cannot be added without one.
 */
export const CANONICAL_SECTION_PURPOSE = {
  Agents:
    "Configured agent roles, runtime enablement, concurrency limits, and effective provider routing.",
  Providers:
    "Configure which providers to use, which models to use for each role, and agent spawn limits.",
  MCPs: "Canonical RuleSync MCP server declarations, role assignments, and target overrides.",
  Skills:
    "Canonical RuleSync skill definitions, the roles that may invoke them, and each skill's assignment state.",
  Hooks:
    "Canonical RuleSync lifecycle hook declarations, matchers, and target projections.",
  Prompts:
    "Canonical RuleSync command prompts, validation status, and target projections.",
  Permissions:
    "Canonical permission policy, effective role capability matrix, and MCP tool grants.",
  Tools:
    "Effective tool catalog across native, MCP, plugin, and app capabilities.",
  Usage:
    "Active runtime sessions and OpenTelemetry request, token, cost, latency, and trace telemetry.",
  Evaluations:
    "Retained evaluation results, metric breakdowns, and linked OpenTelemetry traces.",
  Playtesting:
    "Workspace-scoped playtest sessions, recorded episodes, analyst findings, and matched comparisons.",
  Memory:
    "Governed durable claims, raw experiences, lifecycle governance, and bounded outcome cohorts.",
  Workspaces:
    "Configured repository workspaces, execution scope, playtesting target approvals, and aggregate request usage.",
  GitHub:
    "Repository workflow definitions, cron schedules, and observed GitHub Actions runs."
} as const satisfies Record<CanonicalNavSection, string>;

/**
 * The one sentence that says what a canonical resource is for.
 */
export function canonicalSectionPurpose(section: CanonicalNavSection): string {
  return CANONICAL_SECTION_PURPOSE[section];
}

/**
 * Flattened canonical section list, derived from `CANONICAL_NAV_GROUPS`.
 * Order matches Configure → Observe → Operate; do not redefine it elsewhere.
 */
export const CANONICAL_NAVIGATION: readonly CanonicalNavSection[] =
  CANONICAL_NAV_GROUPS.flatMap((group) => group.sections);

export function isCanonicalNavSection(
  section: string
): section is CanonicalNavSection {
  return (CANONICAL_NAVIGATION as readonly string[]).includes(section);
}

export function navOrderOf(section: CanonicalNavSection): number {
  return CANONICAL_NAVIGATION.indexOf(section);
}

export function isCanonicalNavGroupId(
  group: string
): group is CanonicalNavGroupId {
  return (CANONICAL_NAV_GROUPS as readonly { readonly id: string }[]).some(
    (entry) => entry.id === group
  );
}

/**
 * Resolve the canonical group that owns a given section, or `null` if the
 * section is not part of the canonical resource surface.
 */
export function canonicalNavGroupOf(
  section: CanonicalNavSection
): CanonicalNavGroup<CanonicalNavSection> {
  for (const group of CANONICAL_NAV_GROUPS) {
    if ((group.sections as readonly string[]).includes(section)) {
      return group;
    }
  }
  throw new Error(
    `Section "${section}" is not part of the canonical nav surface.`
  );
}
