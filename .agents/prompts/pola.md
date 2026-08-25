# Resolve one documentation-to-behavior contradiction

Hunt for places where our documentation, option descriptions, or inline comments promise one behaviour but the implementation does something subtly different (for example "0 disables" while the code coerces the value to `null`). Choose one concrete contradiction that would surprise a player or contributor, then either bring the implementation back in line with the documented contract or tighten the docs so the behaviour is explicit. When tweaking text, keep the tone consistent with nearby guidance and call out the change in the PR body so reviewers can weigh whether future code should follow the clarified rule.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
