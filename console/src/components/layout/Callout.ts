/**
Console callout system.

A callout tells the operator a condition they must know about: telemetry is
unavailable, a source could not be observed, a save could not be confirmed.
Every one of those is the same kind of statement, so they are one visual
treatment with a severity, not a layout each caller designs.

The views had drifted into four geometries for the same warning alone —
`rounded-lg` against `rounded`, `p-4` against `p-5` against `p-3`, `text-xs`
against `text-sm`, and a background at 20% opacity against 10% — across 21
call sites in 9 files. Moving between pages changed how loud the same
condition looked.

The severity tokens are drawn from `app/globals.css` at one fixed opacity
rather than per-caller choices. Note that `--color-error` and `--color-warning`
are already very light foreground colours; darkening the surface by stacking a
20% tint behind them reduces their contrast, so the lighter 10% wash is both
the consistent choice and the legible one.

Spacing is deliberately absent from these classes. A callout that needs to sit
further from its neighbours appends its own margin utility, because how much
space a callout needs depends on what surrounds it, and the design token
should not decide that.
*/

/**
The shape every callout shares: the box, and nothing about its colour.

The three tones below are built from this rather than each re-spelling
`rounded border p-3 text-sm`, which left this constant exported and unused
while the same four tokens appeared in every variant. Token order moves here,
but nothing conflicts: this sets border-radius, border-width, padding and
font-size, and a tone adds only border colour, background colour and text
colour.
*/
export const CALLOUT_CLASS = "rounded border p-3 text-sm";

/**
Neutral information: what the Console is showing and where it came from.
*/
export const CALLOUT_ACCENT_CLASS = `${CALLOUT_CLASS} border-accent/60 bg-accent/10 text-accent`;

/**
A condition the operator should check, but which is not a failure.
*/
export const CALLOUT_WARNING_CLASS = `${CALLOUT_CLASS} border-warning/60 bg-warning/10 text-warning`;

/**
Something could not be loaded, confirmed or applied.
*/
export const CALLOUT_ERROR_CLASS = `${CALLOUT_CLASS} border-error/60 bg-error/10 text-error`;

/**
A notice that wears a warning-coloured bar down its left edge.

The boxed callout above is the loud treatment: a tinted panel with a tinted
border. A notice is quieter than that — the operator has to read it, but the
page should not stop around it — so it is a left bar and nothing else, with
the text in the muted colour it had before.

The bar is the only warning-coloured part of it, so the bar carries the tone
and the shape is the bar plus the inset its text sits in. The colour is the
semantic `warning` token rather than a raw palette value: the Console has one
dark theme and one token per meaning, and a bare `amber-500` was a palette
entry pretending to be a product decision.
*/
export const CALLOUT_BAR_WARNING_CLASS = "border-l-2 border-l-warning pl-3";
