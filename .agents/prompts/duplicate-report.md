# Resolve one reported duplication cluster

Use the target repository's documented duplication report or a targeted search to identify one small cluster of duplicated logic. Consolidate it at the authoritative owner by reusing an existing helper or introducing one justified shared abstraction. Do not depend on a workflow-provided report variable or assume a particular lint command. Preserve behavior, avoid broad refactoring, add focused regression coverage where needed, and rerun the relevant validation.
