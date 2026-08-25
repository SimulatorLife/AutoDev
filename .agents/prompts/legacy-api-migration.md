# Migrate one deprecated API use

Detect a call site using a deprecated library/API or internal module slated for removal. Replace it with the recommended modern equivalent, adjusting surrounding code as needed. Update inline docs or comments to reflect the new API, and add regression coverage or manual validation notes proving behaviour parity. Limit the scope to one meaningful migration so the diff stays focused.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
