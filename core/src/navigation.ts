/**
 * Canonical AutoDev Console navigation.
 *
 * The grouping below is the single authoritative definition of the Console
 * resource surface. Configure/Observe/Operate are presentation groups; the
 * 13 resources remain first-class routes. Any flattened section list, route
 * slug lookup, or section-order helper is derived from this definition so
 * membership and order can never diverge between parallel declarations.
 *
 * Authority: docs/autodev-console-target-state.md §2 "Canonical resource
 * surface" — Configure = Agents, Providers, MCPs, Skills, Hooks, Prompts,
 * Permissions, Tools; Observe = Usage, Evaluations, Memory; Operate =
 * Workspaces, GitHub.
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
    description: "Telemetry, memory, and historical behavior surfaces.",
    sections: ["Usage", "Evaluations", "Memory"]
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
