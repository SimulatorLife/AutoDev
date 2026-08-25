# Replace one stringly-typed flag

Locate code that branches on raw string literals to determine behaviour. Introduce a typed alternative (enum object, constant map, schema) that centralises valid values, validates inputs, and updates call sites. Add regression coverage showing that invalid strings now fail fast while valid ones keep working. Limit the change to one representative flag or option to keep the diff focused.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
