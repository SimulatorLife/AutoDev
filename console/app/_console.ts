/**
 * Server-side helpers shared by every Console route.
 *
 * Server-only. Imports `./src/lib/server/...` and `./src/components/...`.
 * Must never be imported from any client component.
 */

import { type CanonicalNavSection } from "@simulatorlife/autodev-core";
import React from "react";

import { AppShell } from "../src/components/layout/AppShell.ts";
import { DETAIL_PANEL_SHAPE } from "../src/components/layout/Panel.ts";
import { MUTED_META_CLASS } from "../src/components/ui/text-classes.ts";
import { canonicalSectionFromPath } from "../src/lib/routes.ts";
import {
  type ControlApiConfig,
  readControlApiConfig
} from "../src/lib/server/control-api.ts";

export interface NodeContext {
  readonly config: ControlApiConfig | null;
  readonly section: CanonicalNavSection;
}

/**
 * Resolve the shared, server-only Console context for a route. The control API
 * configuration is `null` when the service token is missing; the route is
 * responsible for rendering an explicit unavailable state instead of falling
 * back to fabricated data.
 */
export function readNodeContext(pathname: string): NodeContext {
  const section = canonicalSectionFromPath(pathname);
  if (!section) {
    throw new Error(
      `Console route path '${pathname}' does not map to a canonical section.`
    );
  }
  return { section, config: readControlApiConfig() };
}

export interface UnavailableProps {
  readonly title: string;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
}

/** Trailing sentence punctuation, which a heading may omit and a message may not. */
const TRAILING_PUNCTUATION = /[.!?:;]+$/;

/**
 * Normalised for the comparison below: case-folded, trimmed, and stripped of
 * trailing punctuation.
 */
function normaliseClaim(value: string): string {
  return value.trim().toLowerCase().replace(TRAILING_PUNCTUATION, "");
}

/**
 * Whether the message says what the heading already said.
 *
 * The heading and the message are authored independently -- the title by the
 * route that caught the failure, the message by the Runtime that raised it --
 * so they can land on the same sentence. `/memory` does: both read "Memory
 * storage is not configured", and the panel printed it twice, once as an `h2`
 * and once as the paragraph under it.
 *
 * `/evaluations` shows the panel working as intended, with a heading and a
 * message that say different things, so this is not the shell always
 * duplicating -- it is two writers agreeing by coincidence, which no reviewer
 * sees in the markup because neither string is wrong on its own.
 *
 * Compared case-insensitively and ignoring trailing punctuation, since a title
 * written without a full stop and a sentence written with one are the same
 * claim. The hint is left alone: it is the part that says what to do, and it is
 * the part most worth keeping even when it restates.
 */
function repeatsTheTitle(title: string, message: string): boolean {
  return normaliseClaim(title) === normaliseClaim(message);
}

/**
 * Give a machine token line-break opportunities at its own separators.
 *
 * `overflow-wrap: break-word` cannot do this on its own: CSS has no break
 * opportunity at `_`, so a snake_case code is one unbreakable word and the
 * browser has to cut it somewhere arbitrary. `break-all` made that arbitrary
 * cut permanent instead of a last resort, and the failure shell then rendered
 * `autodev_control_api_invalid_perm` + `issions_response` — two strings that
 * are not the code, and neither of which matches a line in a log.
 *
 * A `<wbr>` after each separator makes those positions real break
 * opportunities, so the token wraps only between its own groups and each line
 * is a true prefix of the value. It renders no characters, so the element's
 * text is still exactly `code`.
 */
/** Keeps each separator with the group it ends, so a break lands after it. */
const AFTER_UNDERSCORE = /(?<=_)/u;

function breakableToken(value: string): React.ReactNode[] {
  return value
    .split(AFTER_UNDERSCORE)
    .map((part, index) =>
      React.createElement(
        React.Fragment,
        { key: index },
        part,
        React.createElement("wbr")
      )
    );
}

export function ResourceUnavailable({
  title,
  code,
  message,
  hint
}: UnavailableProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      // The failure shell starts from the panel *shape*, not the finished panel, so
      // the severity tint is not competing with the default `bg-surface`.
      className: `${DETAIL_PANEL_SHAPE} flex flex-col gap-3 border-error/40 bg-error/10`,
      role: "alert",
      "data-status": "unavailable",
      "data-error-code": code
    },
    React.createElement(
      "div",
      // An error code is an unbroken machine token that is routinely longer than
      // a narrow card. The row wraps and the code may break anywhere, so a long
      // code never pushes the card (or the document) sideways.
      {
        className: "flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
      },
      React.createElement(
        "h2",
        {
          className: "min-w-0 text-base font-semibold text-error tracking-tight"
        },
        title
      ),
      React.createElement(
        "span",
        {
          // An error code is an unbroken machine token that is routinely longer
          // than a narrow card. It is deliberately not the shared tag shape: that
          // shape sets `whitespace-nowrap`, and a later `whitespace-normal` in
          // the class attribute does not override it — Tailwind resolves two
          // utilities on the same property by stylesheet order. The surrounding
          // row wraps, so a long code never pushes the card or the document
          // sideways.
          //
          // `break-words` is the last resort, not the plan: it only cuts a group
          // that cannot fit a line even on its own. The break opportunities that
          // do the real work are the `<wbr>` elements inside.
          className:
            "max-w-full break-words rounded border border-error/40 bg-error/15 px-2 py-0.5 font-mono text-xs text-error"
        },
        breakableToken(code)
      )
    ),
    React.createElement(
      "p",
      { className: "text-sm text-fg-secondary leading-relaxed" },
      repeatsTheTitle(title, message) ? null : message
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      hint ??
        "Configure the required server-side integration and restart the Console."
    )
  );
}

/**
 * The failure shell for a page whose Control API credential is missing.
 *
 * Eighteen pages open with this guard, and each one used to spell all three
 * parts itself: the title, the machine code, and the sentence naming the
 * environment variable. Only the noun varied — "agent configuration",
 * "governed memory", "tool catalog data" — and that part is genuinely per page.
 * `/evaluations` names evaluation *results*, because the Runtime exposes one
 * `GET /control/evaluations` returning retained results and no definitions read
 * behind it; a page that sent an operator looking for a surface it does not read
 * would point them at a thing the credential was never going to produce.
 *
 * The other two parts are not per page, and they are the parts that go stale.
 * Renaming `AUTODEV_CONTROL_API_TOKEN` or retitling the shell meant eighteen
 * edits, and the seventeen nobody remembered would have kept pointing at a
 * variable that no longer exists. The code is load-bearing past the page
 * too — tests assert on `data-error-code` and logs match on it — so it belongs
 * in one definition rather than eighteen.
 *
 * `reads` is the noun phrase only; the sentence around it is fixed.
 */
export function controlApiCredentialUnavailable(
  reads: string
): React.JSX.Element {
  return React.createElement(ResourceUnavailable, {
    title: "Control API credential is not configured",
    code: "autodev_control_api_disabled",
    message: `Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read ${reads}.`
  });
}

/**
 * Render a Console page with the shared AppShell using the canonical section
 * for navigation highlighting. Counts are surfaced from the props when known
 * so the sidebar reflects the loaded resource state.
 */
export function ConsolePageShell({
  section,
  counts,
  description,
  children
}: {
  readonly section: CanonicalNavSection;
  readonly counts?: Partial<Record<CanonicalNavSection, number>> | undefined;
  readonly description?: string | undefined;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return React.createElement(
    AppShell,
    { activeSection: section, counts, description },
    children
  );
}
