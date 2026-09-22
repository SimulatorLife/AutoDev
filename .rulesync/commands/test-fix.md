---
targets: ["*"]
description: Investigate failing tests, classify each as legacy/regression/flaky, and fix the underlying code for tests that exercise real target behavior.
---
Investigate any/all failing tests in the codebase.

Some may be failing due to being old/legacy-behavior tests, some may be testing real/expected/target functionality that is not yet working or has regressed. Some may just be flaky and need to be stabilized.

You need to carefully evaluate each one to determine which is which, with clear justification.

Then, for each failing test that is testing real/expected/target functionality, fix the underlying issue(s) in the codebase to make the test pass.

Or, if 100% certain that the test is testing old/legacy/deprecated behavior, remove the test and any related code that is no longer needed. Or, if the test expectations can be adapted to the new/target behavior, update the test to reflect the new/target behavior.

Do not disable or blindly remove any tests.

Do not just fix a test to make it pass without fixing the underlying issue in the codebase thoroughly, properly, and structurally.

Do not cause regressions or break other functionality in the process of fixing a test(s).
