# Make one flaky test deterministic

Identify a test known to be flaky (shared globals, timing reliance, leaking timers, real network calls) and refactor it for determinism. Apply fixes such as per-test fixtures, mocked-APIs, better teardown, explicit waits, or fake timers, and include evidence (failing reproduction or reasoning) that the old test flaked. Keep the scope tight by focusing on one flaky scenario and ensuring the suite now runs reliably. IMPORTANT: timeouts on tests to enforce maximum run durations and prevent never-ending tests are *desired* and should be preserved and added where applicable/possible.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
