---
targets: ["*"]
description: Identify and implement one high-value opportunity to unify unnecessarily separate systems, components, behaviors, or effects.
---

Review the codebase holistically to identify and implement **one high-value opportunity to consolidate separate implementations that fundamentally represent the same or closely related concepts.**

**Discovery criteria — look for:**

1. **Shared underlying concepts:** Systems representing the same phenomenon, responsibility, or behavior under different names, contexts, triggers, intensities, or lifecycles that could be variations of one cohesive system.
2. **Parallel implementations:** Related functionality independently maintaining overlapping state, logic, calculations, configurations, rendering, or lifecycle management.
3. **Accidental inconsistencies:** Differences in appearance, behavior, parameters, timing, or semantics caused by independent implementations rather than intentional requirements.
4. **Unnecessary separation:** Artificial boundaries, duplicated responsibilities, or synchronization burdens that a unified model could eliminate.

**Illustrative example (not a specific task):** A racing game separately implements temporary skid marks from braking/cornering and persistent track rubber buildup from driving. Both represent tire rubber deposited on the track, despite different triggers, appearances, and persistence rules. One unified system could calculate deposition intensity from driving conditions, accumulate marks naturally, and render them consistently. Look for analogous opportunities throughout the codebase, not just visual effects.

**Guiding principle:** **Unify concepts, not just code.** Challenge whether separate implementations are necessary rather than merely extracting shared utilities. Avoid forced consolidation, unnecessary abstractions, or relocating complexity.

**Scope:** Complete exactly one well-justified consolidation per run, without unrelated changes. If no valuable opportunity exists, report that rather than forcing a refactor.