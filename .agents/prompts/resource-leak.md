# Fix one resource-lifecycle leak

Identify one hot path where resources (file descriptors, sockets, timers, observers) are created but not reliably disposed. Introduce the minimal fix — finally blocks, AbortController, teardown helpers — that guarantees cleanup even on error, and add an automated test or diagnostic that reproduces the leak without the change. Keep the scope tight: fix one leak thoroughly and document any follow-up considerations if broader work remains.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
