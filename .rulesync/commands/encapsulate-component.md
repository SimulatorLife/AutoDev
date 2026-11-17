---
targets: ["*"]
description: Refactor one fragmented component by consolidating its responsibilities into a cohesive boundary with a clear public API.
---

## Refactor Component Encapsulation

Find one instance (or use the developer-specified scope, if provided) where a cohesive component's responsibilities are fragmented across exported low-level functions, files, or modules, forcing callers to coordinate implementation details.

### Why This Is a Code Smell

- **Poor encapsulation:** Public implementation details allow callers to manipulate component internals independently.
- **Inconsistent state:** Multiple update paths can violate invariants or produce contradictory states.
- **Unclear ownership:** Responsibility is distributed across modules and callers instead of one authoritative component.
- **High coupling:** Callers depend on internal structure, sequencing, and implementation details.
- **Poor discoverability:** Related files scattered across a flat directory obscure component boundaries and make navigation harder.
- **Maintenance burden:** Changes require coordinating multiple files and callers, increasing regression risk.
- **Weak abstractions:** Public APIs expose *how* a component works rather than *what* it does.

### Example

**Before — fragmented API and directory structure:**

```text
ui/
  execute-button-led.ts
  execute-button-led-matrix.ts
  execute-button-view.ts
  debug-mode-events.ts
  mechanical-smoke.ts
```

```ts
export function setExecuteDisabled(button, disabled) { ... }
export function syncExecuteLabel(button, label) { ... }
export function syncExecuteAction(button, action) { ... }
```

Callers must import and coordinate these operations themselves.

**After — cohesive, self-contained component:**

```text
ui/
  execute-button/
    index.ts                # Public entrypoint
    execute-control.ts      # Component implementation
    led.ts                  # Internal
    led-matrix.ts           # Internal
    view.ts                 # Internal
  debug-mode-events.ts
  mechanical-smoke.ts
```

```ts
// index.ts
export { ExecuteControl } from "./execute-control";
```

```ts
// execute-control.ts
export class ExecuteControl {
  update(state: ExecuteState) {
    const view = this.deriveView(state);
    this.applyView(view);
  }

  private deriveView(state) { ... }
  private applyView(view) { ... }
}
```

Caller:

```ts
import { ExecuteControl } from "./execute-button";

executeControl.update(state);
```

### Refactoring Guidelines

- **Component ownership:** Establish one cohesive abstraction with a small, intent-driven public API.
- **Internal encapsulation:** Keep implementation helpers, constants, state derivation, and update logic private.
- **Directory encapsulation:** When multiple files primarily implement one cohesive feature/component, group them into a dedicated directory rather than scattering them across a shared parent.
- **Single entrypoint:** Expose the component through one public entrypoint (e.g., `index` or equivalent). Keep internal modules inaccessible through the supported public API; avoid deep imports.
- **Minimal exports:** Prefer one primary public abstraction. Export additional types or operations only when genuinely required by consumers.
- **Consistent state:** Centralize related state transitions and updates to enforce invariants.
- **Appropriate abstraction:** Use a class/object when identity, state, or lifecycle warrants it; otherwise, a module with private helpers is sufficient.
- **Appropriate grouping:** Organize by cohesive feature/ownership, not merely filename similarity. Keep genuinely shared utilities separate and avoid unnecessary directory nesting.
- **Compatibility:** Update affected imports and callers, preserve behavior, avoid circular dependencies, and verify with relevant tests.

**Goal:** Replace fragmented, caller-orchestrated code with cohesive, self-contained components that own their implementation, directory structure, and minimal public API. Apply where it meaningfully improves design; avoid unnecessary abstractions or rigid one-class-per-directory rules.