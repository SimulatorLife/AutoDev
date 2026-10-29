/**
 * What a detail route answers when the catalogue it reads did not hold the
 * item it was asked for.
 *
 * A catalogue is a read, and a read can fail in three ways that are three
 * different claims:
 *
 *   - it was read, and it does not hold the item. The item is absent, and
 *     "not found" is the whole truth.
 *   - it was read, and it was found broken. The fault is located and the
 *     items it holds are unknown -- including whether it holds this one.
 *   - it was not read at all. Nothing is known about its contents.
 *
 * Only the first state establishes an item's absence. The other two answer a
 * different question -- *could* the item be read -- and answering "not found"
 * for them says the item does not exist, which is a claim nobody made. The
 * operator who is sent looking for a renamed event, server or tool would be
 * looking for the wrong thing: the file that would have named it is what
 * failed.
 *
 * So the second and third states answer "unavailable", carrying the reason
 * with them. A refusal with no explanation is a question the operator cannot
 * answer.
 *
 * The Console does not read anything here. The Runtime publishes the fact
 * (`valid`, `validity`, `executionContractObserved`) and the reasons
 * (`issues`), and this module turns that published fact into the answer the
 * route gives. The rule lives in one place so no detail route can answer
 * "not found" for a catalogue it did not read.
 */

/** How a catalogue read turned out. */
export type CatalogueObservation =
  /** The catalogue was read and holds no fault. */
  | { readonly kind: "observed" }
  /**
   * The catalogue was read and found broken.
   *
   * `reason` is the fault the Runtime located, when it located one.
   */
  | { readonly kind: "invalid"; readonly reason: string | null }
  /**
   * Nothing about the catalogue was read.
   *
   * `reason` names the read that did not happen, when the caller knows which
   * one it was.
   */
  | { readonly kind: "not-observed"; readonly reason: string | null };

/**
 * The observation of a catalogue whose validity the Runtime publishes as a
 * flag, with the reasons it published beside it.
 *
 * `valid === null` is the "not observed" state: the source was neither read
 * nor faulted, and nothing about its contents may be claimed.
 */
export function catalogueObservation(
  valid: boolean | null,
  issues: readonly { readonly message: string }[] = []
): CatalogueObservation {
  if (valid === true) return { kind: "observed" };
  if (valid === false) {
    return { kind: "invalid", reason: issues[0]?.message ?? null };
  }
  return { kind: "not-observed", reason: null };
}

/**
 * The answer a detail route gives for an item its catalogue did not hold.
 *
 * `absent` is the 404. `unavailable` is the refusal, and it carries the
 * title, the machine code and the message the Console renders.
 */
export type CatalogueDetailOutcome =
  | { readonly kind: "absent" }
  | {
      readonly kind: "unavailable";
      readonly title: string;
      readonly code: string;
      readonly message: string;
    };

/**
 * The answer for an item the catalogue did not hold.
 *
 * `subject` names the item ("Hook event", "MCP server", "Tool") and `source`
 * names what was read ("the canonical hook declaration"), so the refusal says
 * which thing could not be read rather than repeating the item's own name.
 */
export function catalogueDetailOutcome(options: {
  readonly subject: string;
  readonly source: string;
  readonly invalidCode: string;
  readonly unobservedCode: string;
  readonly observation: CatalogueObservation;
}): CatalogueDetailOutcome {
  if (options.observation.kind === "observed") return { kind: "absent" };
  const title = `${options.subject} could not be read`;
  if (options.observation.kind === "invalid") {
    return {
      kind: "unavailable",
      title,
      code: options.invalidCode,
      message:
        options.observation.reason ??
        `The ${options.source} is invalid, so its contents could not be read.`
    };
  }
  return {
    kind: "unavailable",
    title,
    code: options.unobservedCode,
    message:
      options.observation.reason ??
      `The ${options.source} was not observed, so its contents could not be read.`
  };
}
