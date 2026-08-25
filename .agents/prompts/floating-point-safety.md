# Fix one floating-point comparison

Find code comparing non-integer numbers using strict equality or inequality that can fail due to rounding error. Replace it with a tolerance-aware helper (epsilon comparison) or another numerically stable approach, and add regression coverage that would flake without the fix. Keep the change surgical by targeting one real-world check where the precision bug is plausibly triggered.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
