# Recover one real validation failure

Run the target repository's documented validation surface and identify one reproducible failing test, build check, lint check, or smallest related failure cluster. Decide whether the expectation is valid; if it is, fix the owning implementation with a focused regression test, and if it is invalid, correct the test with a clear justification. Do not weaken requirements, delete fixtures, or assume a package manager. Work one root cause at a time and rerun the failing validation plus relevant checks.
