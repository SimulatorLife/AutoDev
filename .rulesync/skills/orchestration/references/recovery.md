# Capacity and admission recovery

Read after a delegation admission failure, capacity refusal, or interruption. Follow the ownership and lifecycle requirements in `references/runtime-contract.md`.

1. Recover the exact owned task IDs from the coordinator's admission results or authorized task inventory.
2. Inspect or watch relevant tasks via the canonical delegation interface; preserve running tasks and any partial findings.
3. Distinguish capacity, authorization, confirmation, and transport failures. A timeout is not a terminal result.
4. Resolve only the actual blocker. Allow the runtime to reclaim terminal sessions and release capacity; never perform global cleanup or cancel running work merely to free slots.
5. Retry the original delegation only when the blocker has been resolved and doing so cannot duplicate admitted work.
6. Report the unavailable path if it still fails.

A failed delegation does not authorize bypassing role restrictions or silently substituting a provider-private child mechanism.
