import type {
  ControlApiPromptVersionReference,
  ControlApiPromptVersionsResponse
} from "@simulatorlife/autodev-core";

/**
 * The history the prompt page shows, and where it came from.
 *
 * The committed history of a command is one ordered list of revisions, and a
 * page of it is a window: the operator who needs an older revision asks for
 * the next page instead of being told to go and read Git. The page is named in
 * the URL, so the walk back through the history is addressable.
 *
 * This module owns what the page shows about that window: the revisions it
 * holds, whether more follow them, and where in the list the page sits. The
 * contract's answer is the only source for all three -- the page does not
 * count revisions itself, and it does not decide which revisions exist.
 */
export type PromptHistoryState =
  | {
      readonly status: "available";
      readonly versions: readonly ControlApiPromptVersionReference[];
      readonly hasMore: boolean;
      readonly offset: number;
      readonly limit: number;
    }
  | { readonly status: "unavailable"; readonly message: string };

/**
 * The history the page shows, from what the Control API answered.
 *
 * `null` is the read that did not answer at all, which is a different fact
 * from a repository whose Git cannot answer: one is a service that could not
 * be read, the other is a repository with no history to read.
 */
export function promptHistoryState(
  data: ControlApiPromptVersionsResponse | null
): PromptHistoryState {
  if (data === null) {
    return {
      status: "unavailable",
      message:
        "Committed version history could not be loaded; the canonical working-tree source remains available."
    };
  }
  if (data.status === "unavailable") {
    return {
      status: "unavailable",
      message:
        "Git history is unavailable for this repository; the canonical working-tree source remains available."
    };
  }
  return {
    status: "available",
    versions: data.versions,
    hasMore: data.hasMore,
    offset: data.offset,
    limit: data.limit
  };
}
