# Orchestrating on a web-chat provider

Read this when your replies go through a web chat (`opencli-chatgpt`,
`opencli-gemini`: the response rules say each reply is a round trip through a
web chat). Delegate through `references/xacpx-delegation.md`.

Web-chat round trips may incur substantial latency. Scale delegation to observed cost, independent value, and risk:

- Standard work: delegate one `worker` that does its own discovery for its
  scope. Do not run an `explorer` on the same scope beside or ahead of it; spawn
  an explorer only for a separate question the worker does not need answered
  first.
- Validate Standard work yourself by running the relevant tests and checks
  against the integrated state. Spawn an independent `validator` only for
  High-risk/cross-cutting work.
- Trivial work: do it yourself without spawning.

Prefer bounded waits for meaningful task events over frequent polling; use the canonical task lifecycle through the active tool interface.
