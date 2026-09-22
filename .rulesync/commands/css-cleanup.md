---
targets: ["*"]
description: Perform a comprehensive CSS DRY / cleanup / de-duplication pass that consolidates variables and shared values.
---

There are too many CSS files, duplicate/near-duplicate CSS variables (e.g. values differing by ~1–2px), and repeated raw values that should use shared tokens. Perform a comprehensive **CSS DRY / cleanup / de-duplication pass**.

Consolidate fragmented stylesheets where ownership/cohesion improves; merge equivalent or unnecessarily near-equivalent variables, colors, spacing, borders, shadows, opacity, etc. into canonical shared values; replace genuinely repeated literals with shared variables; remove redundant selectors, declarations, overrides, dead styles, and unnecessary specificity. Prefer existing tokens over new ones, and avoid one-off variables or abstraction for its own sake.

Small visual normalization is allowed where differences appear arbitrary or unintentional, such as nearly identical colors, 1–2px differences, or inconsistent border/shadow/opacity values with no meaningful design distinction. Preserve clearly intentional differences and avoid broader redesigns or material changes to layout, behavior, responsiveness, animation, or theming.

Before removing anything as unused, thoroughly check direct, indirect, dynamic, conditional, and runtime references.

Target: fewer/cohesive CSS files, fewer canonical variables, clearer ownership, more consistent styling, less duplication, and simpler CSS.
