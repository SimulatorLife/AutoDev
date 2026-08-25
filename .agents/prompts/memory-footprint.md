# Reduce one avoidable memory cost

Audit allocation-heavy paths (e.g. cached lookup tables, unintended global variables,  misused closures, unbounded caches, not releasing memory when not needed anymore,  etc.) and locate one clear case of avoidable memory growth or churn. Apply a  localized fix that cuts peak or steady-state usage (e.g., reuse buffers, trim stored  state, clear references promptly) while maintaining deterministic updates and correct  behavior. Include a reproducible measurement (heap snapshot, allocation counter,  Resident Set Size) demonstrating the reduction.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
