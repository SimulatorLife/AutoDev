# Validation

Read this when you plan or run a validation gate: choosing validators, pinning
the state they inspect, or verifying browser behavior.

Validators must be independent of the scope they validate. Pin validation to an
identified repository state (commit/head plus any relevant uncommitted diff),
and provide acceptance criteria, constraints, and expected evidence without
priming validators with the implementer's conclusions unless investigating a
specific finding. Validators for the same gate should inspect the same state.

Prefer complementary evidence, such as:

- architecture/code review + runtime validation
- tests/static analysis + browser behavior
- migration/call-path review + regression testing

Treat agent reports as provisional evidence, not authority. The root resolves
disagreements and determines whether lifecycle gates pass.

## Browser verification

Delegate browser verification to `browser-tester` (`playwright-mcp` launches
`--headless --no-sandbox --isolated`). If headless Chromium fails to launch
inside a macOS Seatbelt sandbox with `MachPortRendezvousServer` permission
denied, retry headless with `["--no-sandbox", "--single-process"]` or fall back
to server/DOM/unit assertions, and report the sandbox Mach port restriction as
an environment boundary rather than a product failure.

Root and child MCP capabilities can differ. For role-scoped MCP
(`browser-tester` -> Playwright, `playtester` -> Playtest), verify a real call
through the routed provider; do not infer exposure from root tools or
telemetry, and never enable those servers at the root.
