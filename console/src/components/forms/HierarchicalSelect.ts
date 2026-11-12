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
 * (never submitted) driving its sibling menu through `peer-checked`, and each
 * level is a native `<details>`; each option is a submit button for its
 * level's own native form, so choosing one applies immediately with no client
 * script, exactly as the auto-submitting selects beside it do.
 *
 * It returns sibling elements rather than one wrapper, so a caller laying the
 * control out on a grid can give the menu a row of its own (`menuClassName`)
 * instead of a popover that a scrolling parent would clip.
 *
 * The level forms are rendered apart, by `HierarchicalSelectForms`, and the
 * buttons reach them through the `form` attribute: the control usually sits
 * inside another form, and a form nested in a form is dropped by the parser,
 * which would send every choice to the outer form instead.
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
    React.createElement("input", {
      id: toggleId,
      type: "checkbox",
      className: "peer sr-only",
      "aria-controls": `${id}-menu`,
      "aria-label": `Open ${label}`
    }),
    React.createElement(
      "label",
      {
        htmlFor: toggleId,
        className: `${wrapperClass} peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2`,
        "data-hierarchical-select": id
      },
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
        className: `m-0 hidden list-none flex-col gap-0.5 rounded border border-border-strong bg-surface-raised p-1 shadow-lg peer-checked:flex ${menuClassName ?? ""}`
      },
      ...levels.map((level) =>
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

/**
 * The level forms a `HierarchicalSelect` submits: one empty native form per
 * level, carrying only its hidden fields. Render them outside any other form.
 */
export function HierarchicalSelectForms({
  id,
  levels,
  disabledReason
}: Pick<
  HierarchicalSelectProps,
  "id" | "levels" | "disabledReason"
>): React.JSX.Element | null {
  if (disabledReason !== undefined) return null;
  return React.createElement(
    React.Fragment,
    null,
    ...levels.map((level) =>
      React.createElement(
        "form",
        {
          key: level.key,
          id: levelFormId(id, level),
          method: "POST",
          action: level.action,
          hidden: true,
          "data-hierarchical-form": level.key
        },
        ...Object.entries(level.hiddenFields).map(([name, value]) =>
          React.createElement("input", {
            key: name,
            type: "hidden",
            name,
            value
          })
        )
      )
    )
  );
}
