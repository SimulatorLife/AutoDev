import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigError,
  parseArgs,
  requiredArg
} from "@simulatorlife/autodev-runtime/config";

test("parseArgs captures --key value pairs into values", () => {
  const { values, flags } = parseArgs(["--mcp-source", "path/to/mcp.toml"]);
  assert.deepEqual(values, { "mcp-source": "path/to/mcp.toml" });
  assert.equal(flags.size, 0);
});

/**
 * Where a valueless `--flag` appears. Both rows reach the same branch in
 * `parseArgs` -- the value is taken only when the next argument exists and
 * does not itself start with `--` -- so these are two positions of one rule
 * rather than two behaviours.
 */
const BOOLEAN_FLAG_POSITIONS = [
  {
    argv: ["--output", "out.json", "--verbose"],
    values: { output: "out.json" },
    flags: ["verbose"]
  },
  {
    argv: ["--dry-run", "--output", "out.json"],
    values: { output: "out.json" },
    flags: ["dry-run"]
  }
] as const;

test("parseArgs treats a --flag with no value as a boolean flag", () => {
  for (const { argv, values, flags } of BOOLEAN_FLAG_POSITIONS) {
    const where = JSON.stringify(argv);
    const parsed = parseArgs([...argv]);
    assert.deepEqual(parsed.values, values, `values for ${where}`);
    assert.deepEqual([...parsed.flags], flags, `flags for ${where}`);
  }
});

/** Where an unflagged argument appears. Both rows raise from the same check. */
const POSITIONAL_POSITIONS = [
  ["positional", "--output", "out.json"],
  ["--output", "out.json", "positional"]
] as const;

test("parseArgs rejects a positional argument wherever it appears", () => {
  for (const argv of POSITIONAL_POSITIONS) {
    assert.throws(
      () => parseArgs([...argv]),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message === "unexpected argument: positional",
      `positional in ${JSON.stringify(argv)} must be rejected`
    );
  }
});

test("requiredArg returns the value when present", () => {
  assert.equal(requiredArg({ "output-dir": "dist" }, "output-dir"), "dist");
});

test("requiredArg throws a ConfigError naming the missing argument", () => {
  assert.throws(
    () => requiredArg({}, "output-dir"),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message === "missing required argument --output-dir"
  );
});
