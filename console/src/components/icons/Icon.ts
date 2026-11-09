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
 * sizing and stroke weight consistent across the product, and a bounded set is
 * only a bounded set if every entry is still used -- so an icon nobody renders
 * is deleted rather than parked here as a spare. Status is carried by
 * `StatusBadge`'s vocabulary rather than by pictograms, which is why there is
 * no "warning" or "info" glyph here: colour plus a written label reads the
 * same in both themes and survives a monochrome rendering.
 */
const CIRCLE_24_PATH = "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z";

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
  Evaluations: ["M22 11.08V12a10 10 0 1 1-5.93-9.14", "M22 4 12 14.01l-3-3"],
  Playtesting: [
    "M6 8h12a4 4 0 0 1 4 4v1a3 3 0 0 1-3 3h-1l-3-3H9l-3 3H5a3 3 0 0 1-3-3v-1a4 4 0 0 1 4-4z",
    "M7 11h4",
    "M9 9v4",
    "M16 11h.01",
    "M19 13h.01"
  ],
  Memory: [
    "M12 2a9 3 0 1 0 0 6 9 3 0 0 0 0-6",
    "M21 12c0 1.66-4 3-9 3s-9-1.34-9-3",
    "M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"
  ],
  Workspaces: [
    "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
  ],
  GitHub: [
    "M6 3v12",
    "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
    "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
    "M18 9a9 9 0 0 1-9 9"
  ],
  chevronDown: ["M6 9l6 6 6-6"],
  chevronLeft: ["M15 18l-6-6 6-6"],
  chevronRight: ["M9 18l6-6-6-6"],
  chevronsLeft: ["M11 17l-5-5 5-5", "M18 17l-5-5 5-5"],
  chevronsRight: ["M13 17l5-5-5-5", "M6 17l5-5-5-5"],
  // Role identity is carried by shape, not hue: the target state requires a
  // consistent white-outline icon on every provider role so a reader tells roles
  // apart without relying on colour. There is deliberately no crown for the
  // Default role -- a crown would make one role a special case in the same
  // column where the other three are peers.
  roleDefault: ["M4 4h16v12H4z", "M9 20h6", "M12 16v4"],
  roleSmart: ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
  roleOrchestrator: [
    "M18 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
    "M6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
    "M18 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
    "M8.59 13.51 15.42 17.49",
    "M15.41 6.51 8.59 10.49"
  ],
  roleSubagent: [
    "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
    "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8"
  ],
  close: ["M18 6 6 18", "m6 6 12 12"],
  refresh: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"],
  spinner: ["M21 12a9 9 0 1 1-6.22-8.56"],
  play: ["m5 3 14 9-14 9V3z"],
  empty: [
    "M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7L10 4H5a2 2 0 0 0-2 2z",
    "M9 13h6"
  ],
  list: [
    "M8 6h13",
    "M8 12h13",
    "M8 18h13",
    "M3 6h.01",
    "M3 12h.01",
    "M3 18h.01"
  ],
  grid: [
    "M3 3h7v7H3z",
    "M14 3h7v7h-7z",
    "M14 14h7v7h-7z",
    "M3 14h7v7H3z"
  ],
  search: [
    "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
    "m21 21-4.35-4.35"
  ],
  repeat: [
    "m17 1 4 4-4 4",
    "M3 11V9a4 4 0 0 1 4-4h14",
    "m7 23-4-4 4-4",
    "M21 13v2a4 4 0 0 1-4 4H3"
  ],
  compass: [
    CIRCLE_24_PATH,
    "m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z"
  ],
  rocket: [
    "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z",
    "m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z",
    "M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0",
    "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"
  ],
  globe: [
    CIRCLE_24_PATH,
    "M2 12h20",
    "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
  ],
  gamepad: [
    "M6 12h4",
    "M8 10v4",
    "M15 13h.01",
    "M18 11h.01",
    "M2 6a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6z"
  ],
  clock: [
    CIRCLE_24_PATH,
    "M12 6v6l4 2"
  ],
  bolt: ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
  trophy: [
    "M6 9H4.5a2.5 2.5 0 0 1 0-5H6",
    "M18 9h1.5a2.5 2.5 0 0 0 0-5H18",
    "M4 22h16",
    "M10 14.66V17c0 .55-.45 1-1 1H8c-.55 0-1 .45-1 1v1h10v-1c0-.55-.45-1-1-1h-1c-.55 0-1-.45-1-1v-2.34",
    "M18 2H6v7a6 6 0 0 0 12 0V2z"
  ],
  dice: [
    "M4 4h16v16H4z",
    "M8 8h.01",
    "M16 8h.01",
    "M12 12h.01",
    "M8 16h.01",
    "M16 16h.01"
  ],
  target: [
    CIRCLE_24_PATH,
    "M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z",
    "M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"
  ],
  eye: [
    "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"
  ],
  coins: [
    CIRCLE_24_PATH,
    "M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8",
    "M12 18V6"
  ],
  flag: [
    "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z",
    "M4 22v-7"
  ],
  brain: [
    "M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04z",
    "M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04z"
  ],
  alertTriangle: [
    "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z",
    "M12 9v4",
    "M12 17h.01"
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

/**
 * The canonical navigation resources, each paired with the icon that stands for
 * it. One list, because the previous shape stated this twice -- as a type union
 * and again as a `Set` literal -- and a resource added to one but not the other
 * would typecheck while silently rendering no icon at all.
 */
const NAV_ICON_SOURCES = [
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
  "Playtesting",
  "Memory",
  "Workspaces",
  "GitHub"
] as const satisfies readonly (Extract<IconName, string> & string)[];

/**
 * Every name in `NAV_ICON_SOURCES` must actually exist in `ICON_PATHS`, and
 * every one must be a canonical navigation section. Either list drifting from
 * its source is a missing glyph in the sidebar, which reads as a design
 * choice rather than a bug -- so both directions are compile errors.
 */
export type NavIconName = (typeof NAV_ICON_SOURCES)[number];

/**
 * Exported so a test can assert the list is exactly the canonical navigation,
 * in both directions. A name here that no section uses is a section that was
 * renamed or removed while its icon stayed behind.
 */
export const NAV_ICONS: readonly NavIconName[] = NAV_ICON_SOURCES;

const NAV_ICON_NAMES: ReadonlySet<string> = new Set<string>(NAV_ICON_SOURCES);

/**
 * Icon for a canonical navigation section, or `null` for a section this set
 * does not cover. Returning `null` rather than guessing keeps an unknown
 * resource from silently borrowing another resource's glyph.
 */
export function navIcon(section: string): NavIconName | null {
  return NAV_ICON_NAMES.has(section) ? (section as NavIconName) : null;
}
