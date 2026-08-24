# Reduce duplication

Inspect the target repository for one focused, high-value instance of duplicated
logic, configuration, or test behavior. Trace the owning abstraction before
editing. Consolidate the duplication at its authoritative owner without adding
a compatibility wrapper or broad unrelated refactor. Preserve behavior, add or
update focused tests, and update documentation when the public behavior or
architecture changes.
