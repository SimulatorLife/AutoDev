# Improve cohesion in one helper cluster

Find one cluster of fragmented helpers or duplicated utilities that should have one clear owner. Extract or merge only that cluster, update all affected callers, and preserve public behavior. Do not rely on workflow allow/deny inputs, introduce a transitional wrapper, or perform broad file moves. Explain the before/after ownership and run focused tests plus the repository's documented validation commands.
