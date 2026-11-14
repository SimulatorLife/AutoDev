"use client";

import React from "react";

import { Icon } from "../icons/Icon.ts";
import { SELECT_CONTROL_CLASS } from "../ui/field-classes.ts";
import { MUTED_META_CLASS } from "../ui/text-classes.ts";
import {
  SELECT_CONTROL_WRAPPER_CLASS,
  SelectChevron
} from "./SelectChevron.ts";

/** One choice inside a level; choosing it submits that level's form. */
export interface HierarchicalSelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * One level of the select: a named target with its own current value and its
 * own form. Choosing an option posts `name=value` with the level's hidden
 * fields to the level's action.
 */
export interface HierarchicalSelectLevel {
  readonly key: string;
  readonly label: string;
  /** What the level is set to now, shown beside its label. */
  readonly current: string;
  /** The option value that is selected now. */
  readonly selected: string;
  readonly action: string;
  readonly name: string;
  readonly hiddenFields: Readonly<Record<string, string>>;
  readonly options: readonly HierarchicalSelectOption[];
}

export interface HierarchicalSelectProps {
  readonly id: string;
  readonly label: string;
  /** The closed control's text. */
  readonly summary: string;
  readonly levels: readonly HierarchicalSelectLevel[];
  /** Classes for the closed control's wrapper (its width, its grid cell). */
  readonly className?: string;
  /** Classes for the opened menu (where it sits in the caller's layout). */
  readonly menuClassName?: string;
  /** Renders the closed control only, with this reason, and no menu. */
  readonly disabledReason?: string | undefined;
}

const MENU_ITEM_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-sm text-fg-secondary hover:bg-surface-muted";

/**
 * A select whose list has levels: each level names a target and opens to the
 * options for that target.
 *
 * The closed control wears the shared select chrome, so it reads as the same
 * control as every other select in a row. Opening it is an unnamed checkbox
 * (never submitted) inside the control's label, which drives the sibling menu
 * through `peer-has-checked`, and each level is a native `<details>`; each
 * option is a submit button for its level's own native form. The menu options
 * mount only while the control is open: the providers table has one menu per
 * provider, and keeping every closed menu's hundreds of options in the DOM
 * made a routine navigation spend a long task inserting controls the operator
 * never opened.
 *
 * The checkbox sits inside the label's own `relative` wrapper on purpose. A
 * visually hidden checkbox is absolutely positioned, so anywhere else it is
 * placed against whichever ancestor happens to be positioned (the app shell),
 * away from the control; clicking the label focuses it, and the browser then
 * scrolls every ancestor, the `overflow-hidden` shell included, to reveal it,
 * leaving the page shifted under an empty band.
 *
 * It returns sibling elements rather than one wrapper, so a caller laying the
 * control out on a grid can give the menu a row of its own (`menuClassName`)
 * instead of a popover that a scrolling parent would clip.
 *
 * The level forms are rendered apart by the provider controls that own their
 * placement, and the buttons reach them through the `form` attribute: the
 * control usually sits inside another form, and a form nested in a form is
 * dropped by the parser, which would send every choice to the outer form
 * instead.
 */
export function HierarchicalSelect({
  id,
  label,
  summary,
  levels,
  className,
  menuClassName,
  disabledReason
}: HierarchicalSelectProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const wrapperClass = `${SELECT_CONTROL_WRAPPER_CLASS} ${className ?? ""}`;
  if (disabledReason !== undefined) {
    return React.createElement(
      "span",
      { className: wrapperClass, "data-hierarchical-select": id },
      React.createElement(
        "span",
        {
          id,
          role: "button",
          "aria-disabled": "true",
          "aria-label": label,
          title: `${summary} — ${disabledReason}`,
          className: `${SELECT_CONTROL_CLASS} block cursor-not-allowed truncate opacity-60`
        },
        summary
      ),
      React.createElement(SelectChevron)
    );
  }
  const toggleId = `${id}-open`;
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "label",
      {
        htmlFor: toggleId,
        className: `${wrapperClass} peer has-focus-visible:outline has-focus-visible:outline-2 has-focus-visible:outline-offset-2`,
        "data-hierarchical-select": id
      },
      React.createElement("input", {
        id: toggleId,
        type: "checkbox",
        className: "sr-only",
        "aria-controls": `${id}-menu`,
        "aria-expanded": open,
        "aria-label": `Open ${label}`,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          setOpen(event.currentTarget.checked)
      }),
      React.createElement(
        "span",
        {
          id,
          title: summary,
          className: `${SELECT_CONTROL_CLASS} block truncate`
        },
        summary
      ),
      React.createElement(SelectChevron)
    ),
    React.createElement(
      "ul",
      {
        id: `${id}-menu`,
        "aria-label": label,
        className: `m-0 hidden list-none flex-col gap-0.5 rounded border border-border-strong bg-surface-raised p-1 shadow-lg peer-has-checked:flex ${menuClassName ?? ""}`
      },
      ...(open ? levels : []).map((level) =>
        React.createElement(
          "li",
          { key: level.key, className: "min-w-0" },
          React.createElement(
            "details",
            { className: "group/level", "data-hierarchical-level": level.key },
            React.createElement(
              "summary",
              {
                className: `${MENU_ITEM_CLASS} cursor-pointer list-none [&::-webkit-details-marker]:hidden`
              },
              React.createElement(Icon, {
                name: "chevronDown",
                size: 12,
                className:
                  "shrink-0 -rotate-90 text-fg-muted group-open/level:rotate-0"
              }),
              React.createElement(
                "span",
                { className: "shrink-0" },
                level.label
              ),
              React.createElement(
                "span",
                {
                  className: "ml-auto min-w-0 truncate " + MUTED_META_CLASS,
                  title: level.current
                },
                level.current
              )
            ),
            React.createElement(
              "div",
              { className: "flex flex-col gap-0.5 pl-5" },
              ...level.options.map((option) =>
                React.createElement(
                  "button",
                  {
                    key: `option-${option.value}`,
                    type: "submit",
                    form: levelFormId(id, level),
                    name: level.name,
                    value: option.value,
                    "aria-pressed":
                      option.value === level.selected ? "true" : "false",
                    className: `${MENU_ITEM_CLASS} cursor-pointer aria-pressed:font-semibold aria-pressed:text-fg`
                  },
                  option.label
                )
              )
            )
          )
        )
      )
    )
  );
}

function levelFormId(id: string, level: HierarchicalSelectLevel): string {
  return `${id}-${level.key}-form`;
}
