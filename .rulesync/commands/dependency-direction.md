---
targets: ["*"]
description: Ensure that foundational abstractions remain independent of the higher-level concepts that consume them, with clear ownership and proper dependency direction.
---

# Dependency Direction and Ownership

## Principle

Foundational abstractions must remain independent of the higher-level concepts that consume them. Each value, behavior, and policy should have a clear owner, with dependencies flowing toward reusable foundations.

## Problem

**Bad:**

```ts
const primitives = {
  defaultTimeout: getWorkflowConfig("checkout").timeout,
  baseColor: getRarityColor("common"),
  standardSpacing: getComponentStyle("dialog").padding,
};
```

These supposedly reusable primitives depend on application-specific concepts, reversing the intended dependency direction.

**Correct architecture:**

```text
Foundational primitives and utilities
                ↓
Domain configuration and semantics
                ↓
Features and consumers
```

Higher layers derive from and compose lower layers, never the reverse.

## Why It Matters

- **Inverted dependencies:** Foundations depending on consumers violate architectural boundaries and risk circular dependencies.
- **Hidden coupling:** Changing domain-specific configuration unexpectedly affects unrelated consumers.
- **Misleading abstractions:** Generic names conceal application-specific behavior, defeating reusability.
- **Unnecessary indirection:** Aliases, lookups, and wrappers obscure definitions without adding meaningful functionality.
- **Ambiguous ownership:** Competing definitions and sources of truth make changes difficult to locate and reason about.
- **Maintenance overhead:** Tangled responsibilities increase regression risk, testing complexity, and architectural drift.

## Correct Approach

**Foundations define reusable primitives:**

```ts
export const defaults = {
  requestTimeoutMs: 5000,
  spacingUnit: 8,
} as const;
```

**Domain layers assign meaning and policy:**

```ts
import { defaults } from "./defaults";

export const checkoutPolicy = {
  timeoutMs: defaults.requestTimeoutMs,
};

export const dialogStyle = {
  padding: defaults.spacingUnit * 2,
};
```

**Consumers use the appropriate abstraction:**

```ts
executeCheckout({
  timeoutMs: checkoutPolicy.timeoutMs,
});
```

## Rules

- Keep foundational modules independent of their consumers.
- Define each concept in the layer that owns its meaning and responsibility.
- Separate reusable mechanisms from application-specific policies.
- Maintain one authoritative definition per concept; derive rather than duplicate.
- Avoid aliases, wrappers, helpers, and abstraction layers without clear value.
- Name abstractions according to what they represent, not unrelated use cases.
- Prevent changes to one semantic concept from unintentionally affecting unrelated functionality.
- Prefer simple, direct dependencies over unnecessary indirection.
- Preserve existing behavior when correcting architectural violations.

## Workflow

1. Identify foundational abstractions, domain semantics, and consumers.
2. Trace dependencies and determine ownership.
3. Find inverted dependencies, hidden coupling, misleading aliases, and duplicate definitions.
4. Refactor definitions into their proper layers and update consumers.
5. Remove obsolete indirection without introducing compatibility layers or unnecessary abstractions.
6. Validate behavior, tests, and dependency boundaries.

Distinguish genuine violations from intentional dependency injection, configuration, and valid composition. Prefer the smallest coherent refactor.

## Guiding Principle

**Foundations define capabilities. Domain layers assign meaning and policy. Consumers compose and use them.**

Abstractions should clarify ownership, enforce dependency boundaries, and reduce coupling—not obscure or reverse them.