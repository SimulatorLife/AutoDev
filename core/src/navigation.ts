export const CANONICAL_NAVIGATION = [
  "Agents",
  "MCPs",
  "Skills",
  "Hooks",
  "Memory",
  "Evaluations",
  "Permissions",
  "Tools",
  "Usage",
  "Prompts",
  "Workspaces"
] as const;

export type CanonicalNavSection = (typeof CANONICAL_NAVIGATION)[number];

export function isCanonicalNavSection(
  section: string
): section is CanonicalNavSection {
  return (CANONICAL_NAVIGATION as readonly string[]).includes(section);
}

export function navOrderOf(section: CanonicalNavSection): number {
  return CANONICAL_NAVIGATION.indexOf(section);
}
