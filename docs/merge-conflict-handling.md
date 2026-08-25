# Merge-conflict handling

A target PR that has real changes but cannot be merged because its branch is
conflict-dirty is not an AutoDev invocation failure. The agent's work and push
have succeeded; the PR is simply not mergeable yet.

## Auto-merge behavior

`target-automerge.yml`:

1. Refuses to merge when GitHub reports `dirty` or `blocked`.
2. If GitHub races with the merge request and returns HTTP 405 for conflicts,
   catches that response instead of failing the matrix job.
3. Updates the existing AutoDev status comment in place with the current head
   SHA and the conflict state.
4. Dispatches `agent-02-resolve-merge-conflicts.yml` for the target PR.

The status comment is keyed by the `autodev-target-automerge` marker, so repeat
runs do not create comment spam. Conflict-resolution request comments are
keyed by the exact current head SHA: one request is allowed for a given commit,
and a new request becomes eligible only after the PR receives a new commit.

After conflict resolution pushes a new commit, the normal target validation and
auto-merge cycle can evaluate that new head again. A dirty PR remains open and
is never merged without a clean merge state and valid target validation evidence.
