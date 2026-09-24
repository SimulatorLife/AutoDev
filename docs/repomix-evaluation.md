# Repomix: Optional Repository Briefing

Repomix is a complementary, optional briefing layer—not AutoDev's code graph or default code-search tool. The primary code understanding path is CodeGraphContext; CocoIndex and LSP retain their focused fallback roles described in [the target state](codebase-context-target.md).

A Repomix briefing is useful only when a task needs high-level project context that is not already obvious from the repository instructions or existing docs. Keep it to:

- `AGENTS.md` and other repository instructions
- Agent skills and development rules
- Architecture/design docs, TODOs, and project state
- Manifests and important configuration
- A high-level directory tree

Include the full text of important documentation/configuration when useful, but omit source-code bodies or include only the source directory structure when CGC already represents implementation relationships. Do not use Repomix to answer symbol, caller, dependency, or implementation-location questions; do not query it and CGC for the same fact.

Repomix is not installed, registered as an AutoDev MCP server, or run automatically for tasks. If a repository owner supplies a briefing, treat it as orientation rather than authoritative evidence about current source; confirm task-relevant implementation details using CGC and targeted files.

AutoDev may evaluate a bounded briefing integration later if repeated evidence shows that high-level repository rules/docs are being rediscovered. Any such integration should remain opt-in, exclude implementation source that CGC already covers, and have an explicit owner for generation and freshness. No performance or compression claim is assumed.
