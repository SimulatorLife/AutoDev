---
targets: ["*"]
description: Eliminate flaky, brittle, or unnecessarily coupled tests through proper isolation and deterministic validation.
---

# Improve test isolation

Identify and fix tests that are flaky, brittle, or unnecessarily coupled to implementation details, mutable content, generated artifacts, shared state, execution order, timing, or external dependencies.

- Test observable behavior, contracts, and invariants rather than incidental implementation details or editable content.
- Preserve a single source of truth. Avoid duplicating production data, configuration, or content in test expectations.
- Use controlled fixtures for unit tests and independently validate integration-test expectations against canonical sources, not stale projections or the implementation under test.
- Separate behavioral correctness from generated-artifact drift detection.
- Use isolated fixtures, mocks, proper teardown, explicit synchronization, and fake timers where appropriate.
- Preserve meaningful assertions, security guarantees, performance thresholds, and bounded execution timeouts.

Fix root causes rather than weakening assertions or updating brittle expectations. Run affected tests and report evidence of improved isolation and reliability.