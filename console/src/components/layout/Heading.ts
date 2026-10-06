import React from "react";

/**
 * Console heading system.
 *
 * Every page used to spell its own heading classes inline. A survey of the
 * feature views found 29 distinct class strings for what is really two roles,
 * rendering the same "uppercase label above a group of fields" at 12px/400,
 * 12px/600 and 14px/600 in `text-fg-muted` or `text-fg-secondary`, with four
 * different bottom margins. Two adjacent detail pages therefore labelled
 * sibling panels at visibly different sizes and weights.
 *
 * These are the canonical definitions. Feature code must consume them instead
 * of writing heading classes inline.
 */

/**
 * A label for a group of fields, panels or rows inside the page body.
 *
 * Deliberately quiet: the shell header already renders the page title as the
 * `h1`, so a body label is an eyebrow under it, not a competing title. Size and
 * weight match every other body label so that moving between pages never
 * changes how loud a section label looks.
 */
export const SECTION_HEADING_CLASS =
  "mb-3 text-xs font-semibold uppercase tracking-wider text-fg-muted";

/**
 * The kicker immediately above an `EntityTitle` — "Model provider", "Agent
 * role", "RuleSync command" — stating what kind of resource the name belongs
 * to. It sits directly on top of the title rather than above a field group,
 * so it takes a tighter bottom margin than `SECTION_HEADING_CLASS`.
 */
export const ENTITY_EYEBROW_CLASS =
  "mb-1 mt-3 text-xs uppercase tracking-wider text-fg-muted";

/**
 * The name of the single resource a detail page is about.
 *
 * Callers must not pick the heading level: `AppShell` already renders the
 * resource as the page `h1`, so the entity name is always the `h2` beneath it.
 * Views that invented their own level produced a second `h1` on `/tools/[name]`
 * and skipped straight from `h1` to `h3` on `/memory`, both of which break the
 * document outline the shell header establishes.
 *
 * `break-words` is load-bearing for the monospaced identifiers: a canonical tool
 * name is one unbreakable token, so without it a long name ran off the edge of
 * a phone viewport with no indication that anything was missing. The size steps
 * down below `sm` because a 24px identifier needs three lines in a phone-width
 * column and dominates the page it is supposed to be titling.
 */
export const ENTITY_TITLE_CLASS =
  "text-xl sm:text-2xl font-bold text-fg break-words";

export interface EntityTitleProps {
  readonly children?: React.ReactNode | undefined;
  /**
   * Render monospaced. Identifiers — canonical tool names, record ids, MCP
   * server names — are set in a fixed pitch so their separators and character
   * set read as an identifier rather than as a display name. Human-facing
   * labels such as an agent or provider name stay proportional.
   */
  readonly mono?: boolean | undefined;
  readonly className?: string | undefined;
}

export function EntityTitle({
  children,
  mono = false,
  className
}: EntityTitleProps): React.JSX.Element {
  return React.createElement(
    "h2",
    {
      className: [
        ENTITY_TITLE_CLASS,
        mono === true ? "font-mono" : "",
        className ?? ""
      ]
        .filter((token) => token !== "")
        .join(" ")
    },
    children
  );
}
