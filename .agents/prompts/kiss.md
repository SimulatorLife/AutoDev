# Keep the design simple

Find one over-engineered active code path in the target repository where a
simpler implementation would preserve behavior and improve clarity or
reliability. Confirm the current behavior and its tests first, then remove
unnecessary layers, branches, or configuration at the owning source. Do not
trade correctness for brevity, add legacy compatibility, or mix in unrelated
cleanup. Add focused regression coverage and update documentation when needed.
