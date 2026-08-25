# Reduce one test-runtime hotspot

Find one long-running or slow test (or suite segment), identify the primary time sinks, and refactor to reduce runtime without weakening coverage. Prefer smaller fixtures, more focused assertions, mocked network calls,and removing  unnecessary I/O or process startup. If setup/teardown dominates, streamline  it or share fixtures safely. Include a brief before/after timing or clear  reasoning, keep scope tight, and ensure the tests remain deterministic.  Include the runtime improvements in the PR description and/or commit message.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
