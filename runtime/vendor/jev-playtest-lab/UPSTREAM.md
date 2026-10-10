# Jev Playtest Lab core

- Upstream: https://github.com/gbesse/jev-playtest-lab
- Pinned commit: `7ca4c5f660d3870f38c828ab7dc8168adc39f1ad`
- License: MIT; see `LICENSE`.
- Unmodified upstream files: `src/core.js` and `test/core.test.js`.
- The upstream test is run verbatim with Node's test runner.

AutoDev uses the upstream `observationHash` and `LoopGuard` for bounded,
repeated state/action detection. The other exports remain upstream source but are
not treated as a generic policy: in particular, `fakeResponse` is a fixture,
`parseDecision` is for Jev's `choice` + `noul` response, and its 255-action cap
is provider-specific. No provider credentials or Jev inference are required by
this integration. Re-audit the pinned API, license, upstream tests and AutoDev
behavior-equivalence tests before changing this commit.
