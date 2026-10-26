/**
 * URL helpers for the Hooks resource. Every Hooks link, the editor's return
 * path, and the mutation redirect are built here so the list, the event's
 * detail view, and the route handler agree on one URL shape.
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

/**
 * The destination a hook write answers to.
 *
 * The editor is on the list and on the event's own detail view, so a write
 * answers to whichever of the two the operator used -- and to nothing else. A
 * destination that named another event's page would take the operator to a
 * declaration they did not write, and a destination the browser chose freely
 * would be an open redirect.
 *
 * A destination that is not one of the two is the list: the write still
 * happened, and the list shows the declaration it was written to.
 */
export function hookWriteReturnPath(raw: string | null, event: string): string {
  if (raw === HOOKS_PATH) return HOOKS_PATH;
  return raw === hookEventPath(event) ? raw : HOOKS_PATH;
}
