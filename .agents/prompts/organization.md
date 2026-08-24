# Improve ownership and organization

Identify one cohesive ownership problem in the target repository: related logic
split across the wrong files, a module with a mismatched responsibility, or a
public surface broader than necessary. Trace callers and tests, then make one
small structural improvement at the proper owner. Preserve behavior, avoid
transitional wrappers, and add focused validation for the moved responsibility.
