/**
 * URL helpers for the Hooks resource. Every Hooks link is built here so the
 * list and the event's detail view agree on one URL shape.
 */

export const HOOKS_PATH = "/hooks";

/**
 * One hook event's own page.
 *
 * The event is the item's name, and the path is the item's address: the same
 * event named in the declaration is the event whose page this is.
 */
export function hookEventPath(event: string): string {
  return `${HOOKS_PATH}/${encodeURIComponent(event)}`;
}
