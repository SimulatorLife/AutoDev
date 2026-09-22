The codebase is really disorganized:

1. There is disparate functionality mixed into the same file when there are already better locations it can and *should* live in
2. There are over-engineered blocks of code that should be simplified: KISS
3. There are too-large files that should be split into already-existing/new files for better cohesion and maintainability
4. There are too many *small* files that should be merged into larger, more cohesive files based on their shared functionality
5. There are duplicate functions, duplicate constants, duplicate types, and duplicate tests that should be consolidated into a single source of truth
6. Move any source code/tests in the root directory into their proper location in src/ or tests/ as applicable; we don't want code in the root directory of the project
7. There are abstractions, wrappers, indirection layers, and pass-through functions that add complexity without providing meaningful reuse or separation and should be removed or collapsed
8. There is unnecessary cross-module coupling that should be reduced by giving functionality clearer ownership and narrower interfaces
9. There are public exports, APIs, types, constants, or helpers exposed more broadly than necessary and their visibility should be narrowed to the smallest appropriate scope
10. There are stale compatibility layers, temporary migration code, deprecated paths, feature remnants, and transitional aliases that are no longer needed and should be removed
11. There is commented-out code, abandoned experimental code, temporary debugging logic, and other repository clutter that should be removed rather than preserved indefinitely
12. There are naming and file-placement inconsistencies that obscure what owns a behavior or where related functionality belongs and these should be normalized where doing so improves discoverability
13. There are modules that import deeply into another module's internal implementation rather than using its intended public boundary, and those dependencies should be corrected
14. There are files whose names no longer accurately represent their responsibilities and they should be renamed when restructuring makes their purpose clearer
15. There are inconsistent organizational patterns for similar functionality and they should be standardized around the clearest existing pattern rather than maintaining multiple competing structures
16. There are responsibilities implemented in the wrong architectural layer or module and they should be moved to the component that actually owns that behavior

Do the following, in this order:
1. Pick **two** of these issues to focus on randomly and exclusively for this task; state the two numbers of the issues you are focusing on
2. Find all instances of these issues in the codebase, up to 5 instances per issue (10 total)
3. For each instance, propose a specific change to fix the issue
4. Implement the changes, ensuring that the code still works as expected and passes all tests