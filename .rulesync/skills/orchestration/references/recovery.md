# Capacity and admission recovery

Read this only after a spawn fails for capacity or admission (`agent thread
limit reached`) or a delegation is interrupted. It assumes the ownership and
parking rules in `references/runtime-contract.md`.

On interruption or admission failure (`agent thread limit reached`):

1. enumerate this parent's children with owner-scoped `list_agents` or `manage_subagents` when available
2. otherwise use the exact child IDs from this parent's own spawn results and `<subagent_notification>` messages -- they are this parent's verified spawn history, including across compaction summaries
3. preserve running children (a wait timeout never implies child failure or justifies termination)
4. collect and preserve any available finished results or partial findings
5. under capacity pressure, evict only this parent's oldest parked/terminal children to free capacity
6. leave running or foreign children untouched
7. retry the original delegation once if recovery freed capacity
8. report the unavailable path if it still fails

Never perform global cleanup. A spawn failure does not authorize silently taking
over delegated implementation work.
