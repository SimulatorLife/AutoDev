import type { ControlApiPromptVersionResponse } from "@simulatorlife/autodev-core";

import type { ControlApiResult } from "./control-api.ts";

/**
 * The prompt's committed history, as the URL asks for it.
 *
 * The history of a command is one ordered list of committed revisions and a
 * page of it is a window: the operator who needs an older revision asks for
 * the next page instead of being told to go and read Git. The page is named in
 * the URL, so the walk back through the history is addressable and a reload
 * shows the operator the list they chose a revision from.
 *
 * Which revisions exist is the Control API's answer and not the page's: a
 * revision the operator reached by paging back is older than the page the
 * page happens to be showing, and a revision URL copied from another page has
 * to keep working. So the selection below reads the service's answer, and the
 * page's own list is only what the operator is looking at.
 */

/** A committed revision is a Git object name: forty or sixty-four hex digits. */
const GIT_REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** A whole offset of zero or more, with no sign and no fraction. */
const WHOLE_OFFSET_PATTERN = /^\d+$/u;

/** The page of the committed history a URL names. */
export function historyOffsetFromQuery(
  value: string | readonly string[] | undefined
): number {
  const offset = typeof value === "string" ? value : value?.[0];
  // A query value that is not a whole offset of zero or more is not an
  // offset. The URL is the operator's to edit, and a page it cannot answer is
  // not an error in the prompt.
  if (offset === undefined || !WHOLE_OFFSET_PATTERN.test(offset)) return 0;
  return Number(offset);
}

/** The committed revision a URL asks to open, and what to say when it cannot. */
export function promptVersionSelection(
  name: string,
  requestedRevision: string | readonly string[] | undefined,
  versionResult: ControlApiResult<ControlApiPromptVersionResponse> | null
): {
  readonly selectedVersion?: ControlApiPromptVersionResponse;
  readonly error?: string;
} {
  if (requestedRevision === undefined) return {};
  if (
    typeof requestedRevision !== "string" ||
    !GIT_REVISION_PATTERN.test(requestedRevision)
  ) {
    return { error: "Select one valid committed prompt revision." };
  }

  if (
    versionResult?.kind === "ok" &&
    versionResult.data.name === name &&
    versionResult.data.versionHash === requestedRevision
  ) {
    return { selectedVersion: versionResult.data };
  }
  if (versionResult?.kind === "http-error" && versionResult.status === 404) {
    return {
      error: "That revision is not a committed version of this command."
    };
  }
  return {
    error:
      "The selected committed version could not be loaded; the current source is unchanged."
  };
}
