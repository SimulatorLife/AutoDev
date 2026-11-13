/**
 * Whether the operator's window is showing the page.
 *
 * Two things in the Console refresh themselves on a timer: the live counts on
 * the pages that carry them, and the live watch on a running playtesting
 * session. Both are worth doing while the operator is looking at them, and
 * neither is worth doing while they are not.
 *
 * A background tab is the common case rather than the rare one. An operator
 * who leaves the Console open in a tab they are not reading has, until now,
 * kept the Console asking the Runtime for a fresh projection of the whole
 * route every five seconds -- on the providers page, that is the largest
 * route in the Console, re-serialized in full every five seconds, for as
 * long as the tab was open.
 *
 * The shape is narrow rather than `Document` so the rule can be exercised
 * without a DOM. A rule that can only be proved in a browser is a rule that
 * is never proved.
 */

export interface VisibilitySource {
  /** Whether the page is currently shown to the operator. */
  readonly isVisible: () => boolean;
  /**
   * Called when the page becomes visible again, and returns the unsubscribe.
   *
   * A page that was hidden comes back to counts that are as old as the
   * moment it was hidden, so becoming visible is itself a reason to
   * refresh: the operator is looking at the page again, and the numbers on
   * it are the ones they are about to read.
   */
  readonly onVisible: (listener: () => void) => () => void;
}

/**
 * The document, as the visibility rule reads it.
 *
 * `visibilityState` is the browser's own answer to "is this page shown",
 * and it is `"hidden"` for a backgrounded tab and for a minimized window.
 * The event is the browser's own signal that the answer changed.
 */
export interface VisibilityDocumentLike {
  readonly visibilityState: string;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/**
 * The document, when there is one.
 *
 * There is no document on the server, and none in a unit test, and a
 * refresh that could not be asked about visibility is a refresh that has
 * nothing to skip: it is visible.
 */
function readBrowserDocument(): VisibilityDocumentLike | undefined {
  const candidate = (
    globalThis as { readonly document?: VisibilityDocumentLike }
  ).document;
  return candidate ?? undefined;
}

/** The unsubscribe of a source that never notifies. */
function unsubscribeNothing(): void {}

function isDocumentVisible(documentRef: VisibilityDocumentLike): boolean {
  return documentRef.visibilityState !== "hidden";
}

function watchVisibility(
  documentRef: VisibilityDocumentLike,
  listener: () => void
): () => void {
  const handleVisibilityChange = (): void => {
    if (!isDocumentVisible(documentRef)) return;
    listener();
  };
  documentRef.addEventListener("visibilitychange", handleVisibilityChange);
  return () => {
    documentRef.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}

/**
 * The browser's own visibility answer.
 *
 * A page that has no document is visible: the server renders it for an
 * operator who asked for it, and there is nothing hidden about that.
 */
export function browserVisibilitySource(
  documentRef: VisibilityDocumentLike | undefined = readBrowserDocument()
): VisibilitySource {
  if (documentRef === undefined) {
    return {
      isVisible: () => true,
      onVisible: () => unsubscribeNothing
    };
  }
  return {
    isVisible: () => isDocumentVisible(documentRef),
    onVisible: (listener: () => void) => watchVisibility(documentRef, listener)
  };
}
