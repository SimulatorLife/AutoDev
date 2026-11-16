# Orchestrating on a web-chat provider

Read this when your replies go through a web chat (`opencli-chatgpt`,
`opencli-gemini`: the response rules say each reply is a round trip through a
web chat). Delegate through `references/codex-code-mode.md`.

Every model turn of yours and of every child costs about a minute, and a
child's first turn costs two. Scale delegation down to match:

- Standard work: delegate one `worker` that does its own discovery for its
  scope. Do not run an `explorer` on the same scope beside or ahead of it; spawn
  an explorer only for a separate question the worker does not need answered
  first.
- Validate Standard work yourself by running the relevant tests and checks
  against the integrated state. Spawn an independent `validator` only for
  High-risk/cross-cutting work.
- Trivial work: do it yourself without spawning.

Every wake while waiting is a full model turn, so the long single wait in the
skill's "Waiting and context budget" section matters most here: a root polling
every 10 seconds spends a turn, and one of the site's tabs, on every wake.
