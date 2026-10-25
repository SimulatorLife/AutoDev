import type { SkillDefinition } from "@simulatorlife/autodev-core";

/**
 * The one owner of the skill catalogue's address.
 *
 * The skill catalogue is sixteen entries in the live instance, each row
 * carrying a role-assignment control, so the table runs to about three
 * screenfuls. The question the page is actually about -- *which skills may
 * role X invoke* -- had no answer on it: the operator had to read the
 * Eligible Roles column of every row, sixty-four role chips spread down three
 * screenfuls, to find out which skills carried the role they cared about.
 *
 * So the catalogue takes the product's own filter bar, and the narrowing is
 * by **role**. Not by name: the catalogue is sorted by name and sixteen short
 * names in one column are a cheap scan, while the role question is the
 * expensive one and it had no answer at all. A role is also a bounded set --
 * the roles the execution contract declares -- so the control that chooses one
 * is a single-choice select, which is what the shared filter bar's on-change
 * mode is for.
 *
 * The narrowing also has to survive the round-trip a role assignment makes.
 * Every checkbox on this page submits immediately through a POST that
 * redirects back to `/skills`, so a narrowed list would have been thrown away
 * by the act of assigning a role: the operator would come back to all sixteen
 * rows and have to find the skill they were just editing.
 *
 * The narrowing travels on the form's *action* rather than in its body,
 * because the body carries the desired role set and nothing else -- a
 * browser submits exactly the fields the assignment means, and a third field
 * there would be a field the route has to be told to ignore. The route then
 * rebuilds the address itself rather than following one it was given, so
 * there is no path in the flow that could point anywhere else.
 */

/** The route the skill catalogue lives at. */
export const SKILLS_LIST_PATH = "/skills";

/**
 * Everything the catalogue's address can carry.
 *
 * `""` means every role, and is never written out: the unfiltered list has
 * one address.
 */
export interface SkillsListFilters {
  readonly role: string;
}

/**
 * The value of a query parameter.
 *
 * A repeated parameter takes its first value, which is what the browser's own
 * form submission produces and what the other list surfaces read.
 */
function firstValue(value: string | readonly string[] | undefined): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return value[0] ?? "";
}

/** The filters an address asks for. */
export function readSkillsFilters(
  params: Readonly<Record<string, string | readonly string[] | undefined>>
): SkillsListFilters {
  return { role: firstValue(params.role).trim() };
}

/**
 * The list's query string, without the route.
 *
 * Exposed on its own because a form action carries it: the role assignment's
 * POST has to come back to the rows the operator narrowed, and the address it
 * comes back to is the list's own.
 */
export function skillsListQueryString(filters: SkillsListFilters): string {
  const role = filters.role.trim();
  if (role === "") return "";
  const params = new URLSearchParams();
  params.set("role", role);
  return params.toString();
}

/**
 * The address of the list.
 *
 * An unfiltered list is written without a query at all rather than with an
 * empty one: a bare `?role=` is a different address from no address, and the
 * list should have one address.
 */
export function skillsListHref(filters: SkillsListFilters): string {
  const query = skillsListQueryString(filters);
  return query ? `${SKILLS_LIST_PATH}?${query}` : SKILLS_LIST_PATH;
}

/**
 * The catalogue's entries a set of filters keeps.
 *
 * A role keeps the skills that are assigned to it. A skill with no assigned
 * role at all is kept by every role filter -- it is the one an operator is
 * most likely looking for when they filter, because an unassigned skill is
 * the one that cannot be invoked by anybody.
 *
 * Generic over the skill shape so that filtering keeps the scope facts a
 * scoped skill carries: a filter that dropped them would strip the page of
 * what it knows about where each skill is installed.
 */
export function filterSkills<T extends SkillDefinition>(
  skills: readonly T[],
  filters: SkillsListFilters,
  rolesBySkill: ReadonlyMap<string, readonly string[]>
): readonly T[] {
  const role = filters.role.trim();
  if (role === "") return skills;
  return skills.filter((skill) => {
    const assigned = rolesBySkill.get(skill.name);
    // A skill the execution contract says nothing about is not "assigned to
    // this role" and is not "not assigned to it" either: it is unassigned, and
    // it is kept so the operator can see it and fix it.
    return assigned === undefined || assigned.includes(role);
  });
}
