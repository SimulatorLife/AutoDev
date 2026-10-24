import assert from "node:assert/strict";
import test from "node:test";

import sandboxConfig, {
  expectTimeoutMs
} from "../playwright.sandbox.config.ts";

/**
 * The sandbox configuration's clocks are real clocks.
 *
 * The acceptance's expect timeout is the clock that says "this page is not
 * going to answer". It was written as `Number("15_000")`, and JavaScript's
 * `Number` does not accept an underscore as a digit separator the way the
 * language's numeric literals do: `Number("15_000")` is `NaN`, not `15000`.
 *
 * A `NaN` timeout is not a long timeout, it is no timeout at all. Every
 * expectation in the acceptance therefore ran to the test's own ten-minute
 * clock, so a page that had not answered was reported as the *test* timing
 * out, ten minutes after the page had given up -- and the report named the
 * test rather than the page. The clock that was supposed to make a failure
 * quick and specific was the reason a failure took ten minutes and said
 * nothing about what had actually happened.
 *
 * So the number is parsed by a function that understands the separator, and
 * the function is pinned here.
 */

const ORIGINAL = process.env.AUTODEV_ACCEPTANCE_EXPECT_TIMEOUT;

function withEnv(value: string | undefined): number {
  if (value === undefined) {
    delete process.env.AUTODEV_ACCEPTANCE_EXPECT_TIMEOUT;
  } else {
    process.env.AUTODEV_ACCEPTANCE_EXPECT_TIMEOUT = value;
  }
  try {
    return expectTimeoutMs();
  } finally {
    if (ORIGINAL === undefined) {
      delete process.env.AUTODEV_ACCEPTANCE_EXPECT_TIMEOUT;
    } else {
      process.env.AUTODEV_ACCEPTANCE_EXPECT_TIMEOUT = ORIGINAL;
    }
  }
}

test("the expect timeout is a number of milliseconds, not NaN", () => {
  assert.equal(withEnv(undefined), 15_000);
  assert.equal(withEnv("90000"), 90_000);
  // The separator the language's own literals use, in a string.
  assert.equal(withEnv("90_000"), 90_000);
});

test("an unreadable timeout falls back to the default rather than to no timeout", () => {
  assert.equal(withEnv("not a number"), 15_000);
  assert.equal(withEnv(""), 15_000);
  assert.equal(withEnv("0"), 15_000);
  assert.equal(withEnv("-1"), 15_000);
});

test("the configuration's own expect timeout is finite and positive", () => {
  const timeout = sandboxConfig.expect?.timeout;
  assert.equal(
    typeof timeout,
    "number",
    "the configuration must carry a numeric expect timeout"
  );
  assert.ok(
    typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0,
    `the expect timeout must be finite and positive, got ${String(timeout)}`
  );
});

test("the configuration's test timeout is finite and positive", () => {
  const timeout = sandboxConfig.timeout;
  assert.ok(
    typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0,
    `the test timeout must be finite and positive, got ${String(timeout)}`
  );
});
