# Reduce one deep collaborator chain

Search the repository for property chains longer than three segments (for example, patterns like `alpha.beta.gamma.delta`). Highlight the exact lines you choose in your summary so reviewers can see the high-risk chains that motivated the work. Refactor the most compelling instance by introducing intermediate helpers, facades, or other seams so collaborators only talk to their immediate neighbours. Keep the fix tightly scoped, document any new helper surfaces, and make sure existing tests still pass.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
