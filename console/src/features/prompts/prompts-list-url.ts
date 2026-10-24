import type { PromptAsset } from "@simulatorlife/autodev-core";

/**
 * The one owner of the prompts list's address.
 *
 * The list is a RuleSync catalog: every canonical command and role prompt in
 * the repository, with no filter of any kind. Measured against the live
 * Console that is 76 entries, and every one of them is a row the operator has
 * to scroll past to reach the one they meant -- while the Tools list beside it
 * filters by source and role, the Evaluations list filters and paginates, and
 * the Memory list filters, searches and paginates.
 *
 * So the list needed the same treatment the other large lists already had, and
 * the treatment is the product's own: a filter bar that submits a normal GET
 * navigation, so the narrowed list is addressable, bookmarkable and shareable
 * like every other filtered view in the Console.
 */

/** The route the prompts list lives at. */
export const PROMPTS_LIST_PATH = "/prompts";

/**
 * The address of the list, narrowed by a query.
 *
 * An empty query is the unfiltered list, and it is written without a `?q=` at
 * all rather than with an empty one: a bare `?q=` is a different address from
 * no address, and the list should have one address.
 */
export function promptsListHref(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return PROMPTS_LIST_PATH;
  return `${PROMPTS_LIST_PATH}?q=${encodeURIComponent(trimmed)}`;
}

/**
 * The query the address carries, if any.
 *
 * A repeated parameter takes its first value, which is what the browser's own
 * form submission produces and what the other list surfaces read.
 */
export function readPromptsQuery(
  params: Readonly<Record<string, string | readonly string[] | undefined>>
): string {
  const raw = params.q;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The prompts a query keeps.
 *
 * The query is matched against the name, the description and the path, because
 * an operator looking for a command knows it by any of the three: the slash
 * command they type, the sentence that describes it, or the file it lives in.
 *
 * Matching is on substrings rather than whole words, so "review" finds
 * "code-review" and "review-notes" alike, and the comparison ignores case
 * because a command name is typed in lower case and a path is not.
 */
export function filterPrompts(
  commands: readonly PromptAsset[],
  query: string
): readonly PromptAsset[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return commands;
  const needle = trimmed.toLowerCase();
  return commands.filter((command) =>
    [command.name, command.description ?? "", command.path].some((field) =>
      field.toLowerCase().includes(needle)
    )
  );
}
