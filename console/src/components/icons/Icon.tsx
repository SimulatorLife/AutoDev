import React from "react";

/**
 * The Console's single icon set.
 *
 * AutoDev Console ships no icon package: every icon is one inline SVG path on a
 * 24x24 grid, stroked with `currentColor` so it inherits the surrounding text
 * color (a muted sidebar item stays muted, an active one turns accent). That
 * keeps the dark-only token set as the only source of icon color and avoids a
 * dependency whose light-theme defaults would leak back into the product.
 *
 * Geometry is the Feather 24x24 stroke grid (2px stroke, round caps and
 * joins) so weights match the type scale instead of reading as a separate icon
 * family. The set is deliberately closed: a bounded set is what keeps icon
 * sizing and stroke weight consistent across the product.
 */
export const ICON_PATHS = {
  Agents: [
    "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2",
    "M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
    "M23 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75"
  ],
  Providers: [
    "M4 4h16v16H4z",
    "M9 9h6v6H9z",
    "M9 1v3",
    "M15 1v3",
    "M9 20v3",
    "M15 20v3",
    "M20 9h3",
    "M20 14h3",
    "M1 9h3",
    "M1 14h3"
  ],
  MCPs: [
    "M18 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
    "M6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
    "M18 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
    "M8.59 13.51 15.42 17.49",
    "M15.41 6.51 8.59 10.49"
  ],
  Skills: ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
  Hooks: [
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
  ],
  Prompts: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  Permissions: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  Tools: [
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
  ],
  Usage: ["M18 20V10", "M12 20V4", "M6 20v-6"],
  Evaluations: [
    "M22 11.08V12a10 10 0 1 1-5.93-9.14",
    "M22 4 12 14.01l-3-3"
  ],
  Memory: [
    "M12 2a9 3 0 1 0 0 6 9 3 0 0 0 0-6",
    "M21 12c0 1.66-4 3-9 3s-9-1.34-9-3",
    "M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"
  ],
  Workspaces: [
    "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
  ],
  Github: ["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6", "M18 9a9 9 0 0 1-9 9"],
  externalLink: [
    "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
    "M15 3h6v6",
    "M10 14 21 3"
  ],
  chevronRight: ["M9 18l6-6-6-6"],
  search: ["M19 11a8 8 0 1 0 0 8 8 8 0 0 0 0-8", "M21 21l-4.35-4.35"],
  clock: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20", "M12 6v6l4 2"],
  info: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20", "M12 16v-4", "M12 8h.01"],
  warning: [
    "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
    "M12 9v4",
    "M12 17h.01"
  ],
  refresh: [
    "M23 4v6h-6",
    "M1 20v-6h6",
    "M3.51 9a9 9 0 0 1 14.85-3.36L23 10",
    "M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
  ],
  empty: [
    "M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7L10 4H5a2 2 0 0 0-2 2z",
    "M9 13h6"
  ]
} as const;

export type IconName = keyof typeof ICON_PATHS;

export interface IconProps {
  readonly name: IconName;
  /**
   * Rendered size in pixels. The grid is 24x24 and the stroke scales with the
   * box, so one number keeps every icon optically identical.
   */
  readonly size?: number | undefined;
  readonly className?: string | undefined;
  /**
   * Accessible name. Omit for decorative icons that repeat adjacent text;
   * supply it for an icon that is the only label for a control.
   */
  readonly label?: string | undefined;
}

export function Icon({
  name,
  size = 16,
  className,
  label
}: IconProps): React.JSX.Element {
  const decorative = label === undefined;
  return React.createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className: `shrink-0${className === undefined ? "" : ` ${className}`}`,
      ...(decorative
        ? { "aria-hidden": true, focusable: false }
        : { role: "img", "aria-label": label })
    },
    ...ICON_PATHS[name].map((d) => React.createElement("path", { key: d, d }))
  );
}

/** Icon that represents each canonical navigation resource. */
export type NavIconName = Extract<
  IconName,
  | "Agents"
  | "Providers"
  | "MCPs"
  | "Skills"
  | "Hooks"
  | "Prompts"
  | "Permissions"
  | "Tools"
  | "Usage"
  | "Evaluations"
  | "Memory"
  | "Workspaces"
  | "Github"
>;

const NAV_ICON_NAMES: ReadonlySet<string> = new Set<string>([
  "Agents",
  "Providers",
  "MCPs",
  "Skills",
  "Hooks",
  "Prompts",
  "Permissions",
  "Tools",
  "Usage",
  "Evaluations",
  "Memory",
  "Workspaces",
  "Github"
]);

/**
 * Icon for a canonical navigation section, or `null` for a section this set
 * does not cover. Returning `null` rather than guessing keeps an unknown
 * resource from silently borrowing another resource's glyph.
 */
export function navIcon(section: string): NavIconName | null {
  return NAV_ICON_NAMES.has(section) ? (section as NavIconName) : null;
}