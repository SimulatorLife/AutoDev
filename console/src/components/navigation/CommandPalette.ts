"use client";

import * as Ariakit from "@ariakit/react";
import {
  CANONICAL_NAV_GROUPS,
  type CanonicalNavSection,
  canonicalSectionPurpose
} from "@simulatorlife/autodev-core";
import React from "react";

import { canonicalNavPath } from "../../lib/routes.ts";
import { MUTED_META_CLASS, MUTED_TEXT_CLASS } from "../ui/text-classes.ts";
import { NavigationLink } from "./NavigationLink.ts";

/**
 * The Console's command palette.
 *
 * Fourteen resources live behind a sidebar of labels, and the sentence that
 * says what each one is for lives in the page's own header -- so an operator
 * who knows what they want ("which surface tells me about context
 * compaction?") has no way to search for it: the labels are in the rail and
 * the purposes are in the pages.
 *
 * Every dashboard that carries this much state solves it the same way. Grafana
 * opens a command palette on `cmd+k` / `ctrl+k`, and its own documentation
 * lists what the palette is for: "search for and open dashboards and
 * folders", "locate pages within Grafana", and "initiate key actions from any
 * page in the application" (Grafana's Search documentation). Linear, GitHub
 * and Vercel carry the same affordance under the same key.
 *
 * So the Console has one too, and it searches the canonical navigation
 * registry -- the same registry the sidebar is built from -- by both the
 * section's name and the sentence that says what it is for. The registry is
 * the single owner of that sentence, so the palette cannot drift from the
 * page header: it reads the same words.
 *
 * Four details make it usable rather than decorative:
 *
 *   - The shortcut is ignored while the operator is typing in a field. A
 *     palette that swallows the letters of a filter is worse than no palette.
 *   - The results are links, so the browser's own affordances -- a new tab,
 *     the back button, the page's own navigation owner -- keep working.
 *   - A result is selected before a key is pressed, and the arrow keys move
 *     the selection, the way every command palette the operator already
 *     knows behaves.
 *   - The search answers in one keystroke: typing filters, and `Enter` opens
 *     the selected match, so the operator never has to reach for the mouse
 *     to get from a question to a page.
 *
 * The last two, and the dialog's own focus handling, are Ariakit's
 * (`@ariakit/react`): its `Dialog` owns modality, Escape, outside dismissal
 * and focus return; `FocusTrapRegion` contains Tab; and its `Combobox` owns
 * virtual focus, the arrow keys and Enter. See
 * https://ariakit.com/examples/dialog-combobox-command-menu.
 *
 * It is a `.ts` module and not a `.tsx` one, and that is not a style
 * preference: the Console's unit tests load the module graph directly, and
 * Node's type stripping does not carry JSX. A `.ts` module that imports a
 * `.tsx` module takes every test that imports it down with it -- nine files
 * at the time this was written. The markup is built with `createElement` for
 * the same reason `AppShell.ts` and `AppNav.ts` build theirs.
 */

interface PaletteResult {
  readonly section: CanonicalNavSection;
  readonly path: string;
  readonly purpose: string;
}

/**
 * The palette's name.
 *
 * One string names the trigger, the dialog and the field, so the thing the
 * operator activates and the thing that opens are the same thing by name.
 */
const PALETTE_NAME = "Find a resource";

/** The field's id, so the label and the input agree on it. */
const PALETTE_INPUT_ID = "command-palette-input";

/** How a result row looks. */
const PALETTE_RESULT_CLASS =
  "flex min-h-6 flex-col gap-0.5 rounded px-3 py-2 transition-colors hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * How the selected result looks.
 *
 * The accent bar is drawn inside the row with an inset shadow, so the
 * selection costs the row no width: a selection that shifted the text would
 * move every line below it when the operator pressed an arrow key.
 */
const PALETTE_ACTIVE_RESULT_CLASS =
  "data-[active-item]:bg-surface-raised data-[active-item]:shadow-[inset_2px_0_0_0_var(--color-accent)]";

/**
 * The key the operator presses.
 *
 * The badge is the affordance: an operator who sees `⌘K` next to a button
 * learns that the palette is one key away, which is the difference between
 * searching the Console and scanning it.
 */
interface Shortcut {
  /** What the badge shows, and what the control's name says. */
  readonly badge: string;
}

/**
 * Whether a result matches the query.
 *
 * The query's words are matched one at a time, not as a phrase, because an
 * operator does not know the Console's wording and types the words they have:
 * "sessions playtest" has to find the page whose purpose says "playtest
 * sessions". A phrase match would answer that query with "no resources match
 * that search", which is worse than no answer -- the operator concludes the
 * resource does not exist.
 *
 * The words are matched against the section's name and its purpose together,
 * so a word can name either.
 */
/** The query's words, however the operator typed them. */
const QUERY_WORDS = /\s+/u;

function matches(result: PaletteResult, query: string): boolean {
  const words = query
    .toLowerCase()
    .split(QUERY_WORDS)
    .filter((word) => word.length > 0);
  if (words.length === 0) return true;
  const haystack = `${result.section} ${result.purpose}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Whether the operator is typing into something, where a shortcut must not fire. */
function isTyping(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

/**
 * The key this machine calls the shortcut.
 *
 * Read from the user agent rather than from a media query, because the
 * question is which keyboard the operator has in front of them and not which
 * screen they are looking at.
 *
 * The badge is one string, and the control's name carries it: the badge is
 * visible text, and a visible word that the name leaves out is a word the
 * operator can see and nobody else can -- which is the same defect as the
 * state pill that was reachable by sight alone, in a different costume.
 */
function shortcutForThisMachine(): Shortcut {
  const nav: { readonly userAgent?: string } = globalThis.navigator;
  const agent = nav.userAgent ?? "";
  return { badge: agent.includes("Mac") ? "⌘K" : "Ctrl K" };
}

export interface CommandPaletteProps {
  /**
   * The resource the operator is on, when they are on one.
   *
   * The palette says which of its results is the page they are already on, so
   * a search that returns the page they are looking at is not a dead end. It
   * is a prop rather than a pathname because the shell already knows which
   * resource it is showing, and a palette that has to ask the router where it
   * is cannot be rendered outside one. A page that belongs to no section marks
   * no result as the current one.
   */
  readonly activeSection: CanonicalNavSection | undefined;
}

/** A result's element id, so the announced selection can name the active row. */
function resultId(section: CanonicalNavSection): string {
  return (
    "command-palette-result-" +
    section.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")
  );
}

/**
 * The palette is Ariakit's dialog around Ariakit's combobox.
 *
 * Ariakit owns everything the keyboard and the focus do: the dialog is modal,
 * so the page behind it is inert, Escape and an outside click dismiss it, and
 * the focus goes to the field on open; the combobox keeps the focus in the
 * field while the arrow keys move a virtual selection that wraps, selects the
 * first match as the query changes, and opens the selected link on Enter. This
 * module keeps only what is the Console's: the registry it searches, the
 * word-by-word match, the global shortcut and its typing guard, the
 * announcements, and the hand-off to the navigation owner.
 *
 * One state, "open", drives both stores, so a result that hides the combobox
 * on click closes the dialog with it.
 */
export function CommandPalette({
  activeSection
}: CommandPaletteProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [shortcut, setShortcut] = React.useState<Shortcut | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  /** Whether the palette closed because the operator chose a destination. */
  const navigatedRef = React.useRef(false);

  const combobox = Ariakit.useComboboxStore({
    open,
    setOpen,
    inputValue: query,
    setInputValue: setQuery,
    // Opening starts a new search: a palette that reopens on the previous
    // query reads as a page that remembered something.
    resetValueOnHide: true,
    focusLoop: true,
    // The selection is always on a result, so the field is not a stop of its
    // own in the arrow-key cycle.
    includesBaseElement: false
  });
  const activeId = Ariakit.useStoreState(combobox, "activeId");

  const results = React.useMemo<readonly PaletteResult[]>(
    () =>
      CANONICAL_NAV_GROUPS.flatMap((group) =>
        group.sections.map((section) => ({
          section,
          path: canonicalNavPath(section),
          purpose: canonicalSectionPurpose(section)
        }))
      ),
    []
  );

  const shown = React.useMemo(
    () => results.filter((result) => matches(result, query)),
    [query, results]
  );

  const activeResult =
    shown.find((result) => resultId(result.section) === activeId) ?? null;

  const count =
    shown.length === 0
      ? "No resources match that search."
      : String(shown.length) +
        " " +
        (shown.length === 1 ? "resource matches" : "resources match") +
        ".";

  /**
   * What the trigger is called.
   *
   * The badge is inside the trigger, so the key is visible text on the
   * control -- and a name that leaves a visible word out removes it. The name
   * therefore carries the key, and the tooltip says the same thing the name
   * says, which is the rule the Console's own links follow.
   */
  const triggerName =
    shortcut === null
      ? PALETTE_NAME
      : PALETTE_NAME + " (" + shortcut.badge + ")";

  React.useEffect(() => {
    setShortcut(shortcutForThisMachine());
  }, []);

  const openPalette = React.useCallback((): void => {
    navigatedRef.current = false;
    setOpen(true);
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "k") return;
      if (!event.metaKey && !event.ctrlKey) return;
      // The shortcut is for reaching the palette, not for interrupting a
      // sentence the operator is writing.
      if (isTyping(event.target)) return;
      event.preventDefault();
      openPalette();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => {
      globalThis.removeEventListener("keydown", onKeyDown);
    };
  }, [openPalette]);

  const trigger = React.createElement(
    "button",
    {
      ref: triggerRef,
      type: "button",
      onClick: openPalette,
      className:
        "flex min-h-6 items-center gap-2 whitespace-nowrap rounded border border-border bg-surface-raised px-2 py-1 text-xs text-fg-muted transition-colors hover:border-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      "aria-label": triggerName,
      title: triggerName,
      "data-command-palette-trigger": true
    },
    React.createElement("span", null, PALETTE_NAME),
    React.createElement(
      "kbd",
      {
        className:
          "inline-block min-w-[2.5rem] rounded border border-border px-1 text-center font-sans text-xs text-fg-muted"
      },
      shortcut?.badge ?? ""
    )
  );

  const label = React.createElement(
    "label",
    { htmlFor: PALETTE_INPUT_ID, className: "sr-only" },
    "Search the Console's resources by name or by what they are for"
  );

  const input = React.createElement(Ariakit.Combobox, {
    store: combobox,
    id: PALETTE_INPUT_ID,
    // The first match is selected before a key is pressed, and again as the
    // query changes. Keep DOM focus on the input; Ariakit exposes the active
    // option through aria-activedescendant for this virtual-focus combobox.
    autoSelect: "always",
    focusOnMove: false,
    autoFocus: true,
    placeholder: "Search the Console's resources",
    className:
      "w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
  });

  const countLine = React.createElement(
    "p",
    {
      className: MUTED_META_CLASS + " border-b border-border px-3 py-1.5",
      role: "status",
      "data-palette-count": "true"
    },
    count
  );

  /**
   * What the palette has selected, said out loud.
   *
   * The selection is a visual accent bar, and a screen reader user cannot see
   * an accent bar. The count says how many resources match; this says which
   * one Enter would open, and it changes only when the selection does.
   */
  const selection = React.createElement(
    "p",
    {
      className: "sr-only",
      role: "status",
      "data-palette-selection": "true"
    },
    activeResult === null ? "" : activeResult.section + " is selected."
  );

  const entries = shown.map((result) =>
    React.createElement(
      Ariakit.ComboboxItem,
      {
        key: result.section,
        id: resultId(result.section),
        focusOnHover: true,
        // Choosing a result closes the palette and hands the focus to the
        // navigation owner rather than back to the trigger.
        hideOnClick: true,
        setValueOnClick: false,
        onClick: (): void => {
          navigatedRef.current = true;
        },
        render: React.createElement(NavigationLink, {
          href: result.path,
          className: PALETTE_RESULT_CLASS + " " + PALETTE_ACTIVE_RESULT_CLASS
        })
      },
      React.createElement(
        "span",
        { className: "text-sm text-fg" },
        result.section,
        result.section === activeSection
          ? React.createElement(
              "span",
              { className: MUTED_META_CLASS },
              " · on this page"
            )
          : null
      ),
      React.createElement(
        "span",
        { className: "line-clamp-2 text-xs " + MUTED_META_CLASS },
        result.purpose
      )
    )
  );

  const list =
    shown.length === 0
      ? React.createElement(
          "p",
          {
            className:
              "min-h-0 max-h-80 flex-1 overflow-y-auto p-2 px-3 py-6 text-center text-sm " +
              MUTED_TEXT_CLASS
          },
          "No resource matches that. Try a resource's name, or what it is for."
        )
      : React.createElement(
          Ariakit.ComboboxList,
          {
            store: combobox,
            alwaysVisible: true,
            className: "min-h-0 max-h-80 flex-1 overflow-y-auto p-2"
          },
          entries
        );

  const dialogContent = React.createElement(
    Ariakit.FocusTrapRegion,
    { enabled: true, className: "flex min-h-0 flex-1 flex-col" },
    React.createElement(
      "div",
      { className: "border-b border-border p-3" },
      label,
      input
    ),
    countLine,
    selection,
    list
  );

  return React.createElement(
    React.Fragment,
    null,
    trigger,
    React.createElement(
      Ariakit.Dialog,
      {
        open,
        onClose: (): void => {
          setOpen(false);
        },
        modal: true,
        unmountOnHide: true,
        "aria-label": PALETTE_NAME,
        "data-command-palette": true,
        // Dismissal hands the focus back to the trigger however the palette
        // was opened. A palette that closed by navigating leaves the focus to
        // the navigation owner, which moves it to the new page's heading.
        finalFocus: triggerRef,
        autoFocusOnHide: (): boolean => !navigatedRef.current,
        // The dialog and its backdrop are rendered into the document by
        // Ariakit's portal. The shell's header carries a backdrop-blur, which
        // makes it the containing block for fixed descendants, so a palette
        // rendered inside the header would be fixed to the header and not to
        // the window.
        backdrop: React.createElement("div", {
          className: "fixed inset-0 z-50 bg-black/60",
          "data-command-palette-backdrop": true
        }),
        className:
          // Bounded by the window it opens in: a palette taller than a short
          // viewport would put its lower half out of reach.
          "fixed left-1/2 top-24 z-50 flex w-[calc(100%-2rem)] max-w-xl max-h-[calc(100vh-7rem)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
      },
      dialogContent
    )
  );
}
