# Separate one policy from its mechanism

Inspect modules where policy decisions (flags, thresholds, cache sizing, heuristic lookups, or other conditional rules) are implemented in the same place that performs operational side effects. Look for code that both decides "what" should happen and immediately carries out the "how", leaving no seam to exercise the policy independently.
For one of these hotspots, design and implement a refactor that extracts the policy computation into a dedicated evaluator, ruleset, or strategy object. Adjust the mechanism code to depend on the extracted policy rather than recomputing heuristics inline. Ensure the new abstraction keeps existing behaviour intact, adds focused unit coverage where practical, and documents the separation so future contributors keep policy and mechanisms decoupled.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
