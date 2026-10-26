"use client";

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
 * Three details make it usable rather than decorative:
 *
 *   - The shortcut is ignored while the operator is typing in a field. A
 *     palette that swallows the letters of a filter is worse than no palette.
 *   - The results are links, so the browser's own affordances -- a new tab,
 *     the back button, the page's own navigation owner -- keep working.
 *   - The search answers in one keystroke: typing filters, and `Enter` opens
 *     the first match, so the operator never has to reach for the mouse to
 *     get from a question to a page.
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
  "bg-surface-raised shadow-[inset_2px_0_0_0_var(--color-accent)]";

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

function matches(result: PaletteResult, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    result.section.toLowerCase().includes(needle) ||
    result.purpose.toLowerCase().includes(needle)
  );
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

/** The controls the keyboard can reach inside the dialog. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The controls the operator can reach inside the dialog, in the order the
 * dialog puts them in.
 */
function focusableWithin(container: HTMLElement): readonly HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((element) => element.getClientRects().length > 0);
}

export interface CommandPaletteProps {
  /**
   * The resource the operator is on.
   *
   * The palette says which of its results is the page they are already on, so
   * a search that returns the page they are looking at is not a dead end. It
   * is a prop rather than a pathname because the shell already knows which
   * resource it is showing, and a palette that has to ask the router where it
   * is cannot be rendered outside one.
   */
  readonly activeSection: CanonicalNavSection;
}

export function CommandPalette({
  activeSection
}: CommandPaletteProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [shortcut, setShortcut] = React.useState<Shortcut | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const listRef = React.useRef<HTMLUListElement | null>(null);

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

  /**
   * The result the palette has selected.
   *
   * Every command palette the operator already knows selects a result and
   * opens the selection with `Enter`: VS Code, Linear, Raycast and GitHub all
   * have the first match selected before a key is pressed, and all of them let
   * the arrow keys move the selection. A palette that only filters is a
   * palette that makes the operator reach for the mouse to pick the third
   * match of five.
   */
  const activeResult = shown[activeIndex] ?? null;

  const count =
    shown.length === 0
      ? "No resources match that search."
      : `${shown.length} ${shown.length === 1 ? "resource matches" : "resources match"}.`;

  /**
   * What the trigger is called.
   *
   * The badge is inside the trigger, so the key is visible text on the
   * control -- and a name that leaves a visible word out removes it. The name
   * therefore carries the key, and the tooltip says the same thing the name
   * says, which is the rule the Console's own links follow.
   */
  const triggerName =
    shortcut === null ? PALETTE_NAME : `${PALETTE_NAME} (${shortcut.badge})`;

  React.useEffect(() => {
    setShortcut(shortcutForThisMachine());
  }, []);

  /**
   * Opening starts a new search.
   *
   * The field is emptied rather than left holding the last query: a palette
   * that reopens on the previous search reads as a page that remembered
   * something, and the operator has to clear it before they can ask the next
   * question.
   */
  const openPalette = React.useCallback((): void => {
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }, []);

  /**
   * Closing hands the focus back, unless the palette closed because the
   * operator chose a destination.
   *
   * A dialog that takes the focus and gives it back to nothing drops the
   * operator at the top of the document, which is further from where they
   * were than the trigger they came from. A palette that closed *by
   * navigating* is a different thing: the page is changing, and the console's
   * own rule for that is to move the focus to the new page's heading, so the
   * focus is left alone here and the navigation owner has it.
   */
  const closePalette = React.useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus({ preventScroll: true });
    }
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

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!open) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePalette(true);
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => {
      globalThis.removeEventListener("keydown", onKeyDown);
    };
  }, [closePalette, open]);

  React.useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, [open]);

  /**
   * The focus stays inside the dialog.
   *
   * The dialog says it is modal, which tells assistive technology that the
   * page behind it is not there any more. Without this, the keyboard walked
   * straight off the dialog and into the page behind it -- invisible under
   * the overlay, and still announced -- so the modal claim was a lie the
   * keyboard told.
   */
  const containFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget;
    const focusable = focusableWithin(dialog);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (active === last || !dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  /**
   * The arrow keys move the selection.
   *
   * The focus stays in the field, because the field is where the answer is
   * typed: a palette that moved the focus onto a row would stop filtering on
   * the next keystroke. The selection is a separate thing from the focus, and
   * it wraps, because a list of fourteen resources is longer than a screen.
   */
  const moveSelection = (
    event: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (shown.length === 0) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    setActiveIndex((index) => (index + step + shown.length) % shown.length);
  };

  /**
   * The selected row is kept in view.
   *
   * The list scrolls, not the page: the dialog is fixed to the window, and
   * moving the window under the operator would move the whole Console.
   */
  React.useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const selected = list.querySelector<HTMLElement>(
      '[data-palette-active="true"]'
    );
    if (selected === null) return;
    const listBox = list.getBoundingClientRect();
    const row = selected.getBoundingClientRect();
    if (row.top < listBox.top) {
      list.scrollTop -= listBox.top - row.top;
    } else if (row.bottom > listBox.bottom) {
      list.scrollTop += row.bottom - listBox.bottom;
    }
  }, [activeIndex, open, shown]);

  /**
   * `Enter` opens the selected match.
   *
   * The palette exists so the operator can get from a question to a page
   * without the mouse, and a search that needs a click to finish is a search
   * that needs the mouse. The keystroke opens what the list has selected, so
   * the keystroke and the eye agree on what it will open.
   */
  const openSelectedMatch = (
    event: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (event.key !== "Enter") return;
    const selected = listRef.current?.querySelector<HTMLAnchorElement>(
      '[data-palette-active="true"]'
    );
    const target =
      selected ?? listRef.current?.querySelector<HTMLAnchorElement>("a[href]");
    if (target === undefined || target === null) return;
    event.preventDefault();
    target.click();
  };

  /**
   * The field's own keys.
   *
   * The arrow keys move the selection and `Enter` opens it. Both are handled
   * on the field rather than on the list, because the field is where the
   * operator's attention is and where their next keystroke belongs.
   */
  const handleFieldKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    moveSelection(event);
    openSelectedMatch(event);
  };

  /**
   * A click on the overlay closes the palette.
   *
   * The click has to land on the overlay itself: a click inside the dialog is
   * a click on a result, and closing the palette under the operator's own
   * click would throw away the choice they were making.
   */
  const handleOverlayClick = (
    event: React.MouseEvent<HTMLDivElement>
  ): void => {
    if (event.target !== event.currentTarget) return;
    closePalette(true);
  };

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

  const field = React.createElement(
    "label",
    { htmlFor: PALETTE_INPUT_ID, className: "sr-only" },
    "Search the Console's resources by name or by what they are for"
  );

  const input = React.createElement("input", {
    id: PALETTE_INPUT_ID,
    ref: inputRef,
    value: query,
    onChange: (event: React.ChangeEvent<HTMLInputElement>): void => {
      setQuery(event.target.value);
      // A new search starts at its first match.
      setActiveIndex(0);
    },
    onKeyDown: handleFieldKeyDown,
    placeholder: "Search the Console's resources",
    autoComplete: "off",
    className:
      "w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
  });

  const countLine = React.createElement(
    "p",
    {
      className: `${MUTED_META_CLASS} border-b border-border px-3 py-1.5`,
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
   * one `Enter` would open, and it changes only when the selection does.
   */
  const selection = React.createElement(
    "p",
    {
      className: "sr-only",
      role: "status",
      "data-palette-selection": "true"
    },
    activeResult === null ? "" : `${activeResult.section} is selected.`
  );

  const empty = React.createElement(
    "li",
    { className: `px-3 py-6 text-center text-sm ${MUTED_TEXT_CLASS}` },
    "No resource matches that. Try a resource's name, or what it is for."
  );

  const entries = shown.map((result, index) => {
    const isActive = index === activeIndex;
    return React.createElement(
      "li",
      { key: result.section },
      React.createElement(
        NavigationLink,
        {
          href: result.path,
          onClick: (): void => {
            closePalette(false);
          },
          dataAttributes: isActive ? { "data-palette-active": "true" } : {},
          className: isActive
            ? `${PALETTE_RESULT_CLASS} ${PALETTE_ACTIVE_RESULT_CLASS}`
            : PALETTE_RESULT_CLASS
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
          { className: `line-clamp-2 text-xs ${MUTED_META_CLASS}` },
          result.purpose
        )
      )
    );
  });

  const dialog = React.createElement(
    "div",
    {
      role: "dialog",
      "aria-modal": true,
      "aria-label": PALETTE_NAME,
      onKeyDown: containFocus,
      className:
        "w-full max-w-xl overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
    },
    React.createElement(
      "div",
      { className: "border-b border-border p-3" },
      field,
      input
    ),
    countLine,
    selection,
    React.createElement(
      "ul",
      { ref: listRef, className: "max-h-80 overflow-y-auto p-2" },
      shown.length === 0 ? empty : entries
    )
  );

  const overlay = React.createElement(
    "div",
    {
      className:
        "fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-24",
      "data-command-palette": true,
      onClick: handleOverlayClick
    },
    dialog
  );

  return React.createElement(
    React.Fragment,
    null,
    trigger,
    open ? overlay : null
  );
}
