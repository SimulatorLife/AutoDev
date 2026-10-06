/**
 * Console callout system.
 *
 * A callout tells the operator a condition they must know about: telemetry is
 * unavailable, a source could not be observed, a save could not be confirmed.
 * Every one of those is the same kind of statement, so they are one visual
 * treatment with a severity, not a layout each caller designs.
 *
 * The views had drifted into four geometries for the same warning alone —
 * `rounded-lg` against `rounded`, `p-4` against `p-5` against `p-3`, `text-xs`
 * against `text-sm`, and a background at 20% opacity against 10% — across 21
 * call sites in 9 files. Moving between pages changed how loud the same
 * condition looked.
 *
 * The severity tokens are drawn from `app/globals.css` at one fixed opacity
 * rather than per-caller choices. Note that `--color-error` and `--color-warning`
 * are already very light foreground colours; darkening the surface by stacking a
 * 20% tint behind them reduces their contrast, so the lighter 10% wash is both
 * the consistent choice and the legible one.
 *
 * Spacing is deliberately absent from these classes. A callout that needs to sit
 * further from its neighbours appends its own margin utility, because how much
 * space a callout needs depends on what surrounds it, and the design token
 * should not decide that.
 */

export const CALLOUT_CLASS = "rounded border p-3 text-sm";

/** Neutral information: what the Console is showing and where it came from. */
export const CALLOUT_ACCENT_CLASS =
  "rounded border border-accent/40 bg-accent/10 p-3 text-sm text-accent";

/** A condition the operator should check, but which is not a failure. */
export const CALLOUT_WARNING_CLASS =
  "rounded border border-warning/40 bg-warning/10 p-3 text-sm text-warning";

/** Something could not be loaded, confirmed or applied. */
export const CALLOUT_ERROR_CLASS =
  "rounded border border-error/40 bg-error/10 p-3 text-sm text-error";
