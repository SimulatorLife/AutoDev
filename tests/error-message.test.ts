import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";

const repositoryRoot = path.join(import.meta.dirname, "..");

// Walk the tree rather than reading `git ls-files`: a newly added module is
// untracked until it is committed, and a guard that cannot see the file it
// exists to police would report a clean tree no matter what was written.
function runtimeSources(directory = "runtime/src"): string[] {
  const root = path.join(repositoryRoot, directory);
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...runtimeSources(path.relative(repositoryRoot, child)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(path.relative(repositoryRoot, child));
    }
  }
  return found.sort();
}

test("errorMessage keeps the reason for Errors and for whatever else was thrown", () => {
  assert.equal(errorMessage(new Error("upstream refused")), "upstream refused");

  // A thrown value is not always an Error, and that is exactly when the
  // message is most likely to be the only evidence left.
  assert.equal(errorMessage({ code: "E_NO_KEY" }), "[object Object]");
  assert.equal(errorMessage("plain string"), "plain string");
  assert.equal(errorMessage(42), "42");
  assert.equal(errorMessage(null), "null");
  assert.equal(errorMessage(undefined), "undefined");

  // Subclasses and empty messages keep their own behaviour rather than being
  // rewritten into something friendlier that hides the value.
  class ProviderError extends Error {
    override name = "ProviderError";
  }
  assert.equal(
    errorMessage(new ProviderError("agy spawn failed")),
    "agy spawn failed"
  );

  const emptied = new Error("placeholder");
  emptied.message = "";
  assert.equal(errorMessage(emptied), "");
});

test("the Runtime has exactly one errorMessage definition", () => {
  const declaring = runtimeSources().filter((file) =>
    /function errorMessage\s*\(/u.test(
      readFileSync(path.join(repositoryRoot, file), "utf8")
    )
  );
  assert.deepEqual(declaring, ["runtime/src/shared/error-message.ts"]);
});

test("modules converted to the shared owner do not re-inline the ternary", () => {
  // `spawn-shim.ts` and the CLI renderers were converted off the inline
  // `error instanceof Error ? error.message : ...` spelling so there is one
  // named decision rather than three interchangeable ones.
  const converted = [
    "runtime/src/router/proxy.ts",
    "runtime/src/router/state-collector.ts",
    "runtime/src/providers/antigravity.ts",
    ...[
      "render-bridge-mcp-catalogue",
      "render-execution-contract",
      "compose-user-config",
      "render-model-catalog",
      "render-agent-configs"
    ].map((name) => `runtime/src/config/${name}.ts`)
  ];
  for (const file of converted) {
    assert.doesNotMatch(
      readFileSync(path.join(repositoryRoot, file), "utf8"),
      /error instanceof Error \? error\.message/u,
      `${file} still decides how to render a caught value inline`
    );
  }
});
