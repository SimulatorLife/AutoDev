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

test("parseArgs treats a trailing --flag with no value as a boolean flag", () => {
  const { values, flags } = parseArgs(["--output", "out.json", "--verbose"]);
  assert.deepEqual(values, { output: "out.json" });
  assert.deepEqual([...flags], ["verbose"]);
});

test("parseArgs treats a --flag immediately followed by another --flag as boolean", () => {
  const { values, flags } = parseArgs(["--dry-run", "--output", "out.json"]);
  assert.deepEqual(values, { output: "out.json" });
  assert.deepEqual([...flags], ["dry-run"]);
});

test("parseArgs rejects a positional argument that does not start with --", () => {
  assert.throws(
    () => parseArgs(["positional", "--output", "out.json"]),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message === "unexpected argument: positional"
  );
});

test("parseArgs rejects a positional argument following a recognized flag", () => {
  assert.throws(
    () => parseArgs(["--output", "out.json", "positional"]),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message === "unexpected argument: positional"
  );
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
