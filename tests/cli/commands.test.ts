import assert from "node:assert/strict";
import test from "node:test";

import { main, runMain } from "../../src/cli/autodev.ts";
import { UnmigratedRuntimeError } from "../../src/cli/runtime.ts";

test("CLI dispatches router, provider, hook, and install through typed backends", () => {
  const calls: string[] = [];
  const result = runMain(["router", "run"], {
    router: {
      run: () => {
        calls.push("router run");
        return 11;
      },
      ensure: () => {
        calls.push("router ensure");
        return 12;
      },
      status: () => ({ state: "running" })
    }
  });
  assert.equal(result, 11);
  assert.deepEqual(calls, ["router run"]);

  assert.equal(
    runMain(["provider", "claude"], {
      provider: {
        start: (name) => {
          calls.push(`provider ${name}`);
          return 13;
        }
      }
    }),
    13
  );
  assert.equal(
    runMain(["hook", "skill-read"], {
      hook: {
        run: (name) => {
          calls.push(`hook ${name}`);
          return 14;
        }
      }
    }),
    14
  );
  assert.equal(
    runMain(["install"], {
      install: {
        install: () => {
          calls.push("install");
          return 15;
        }
      }
    }),
    15
  );
  const installArgs: string[] = [];
  assert.equal(
    runMain(["install", "--materialize-only"], {
      install: {
        install: (args = []) => {
          installArgs.push(...args);
          return 16;
        }
      }
    }),
    16
  );
  assert.equal(
    runMain(["repo", "bootstrap", "--check"], {
      repo: {
        bootstrap: (args = []) => {
          calls.push(`repo bootstrap ${args.join(" ")}`);
          return 17;
        }
      }
    }),
    17
  );
  assert.deepEqual(installArgs, ["--materialize-only"]);
  assert.deepEqual(calls, [
    "router run",
    "provider claude",
    "hook skill-read",
    "install",
    "repo bootstrap --check"
  ]);
});

test("router status uses its typed status result", () => {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  // Command output goes to stdout through src/shared/output.ts.
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk).trimEnd());
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(
      runMain(["router", "status"], {
        router: {
          run: () => 0,
          ensure: () => 0,
          status: () => ({
            state: "running",
            endpoint: "http://127.0.0.1:4100",
            pid: 42
          })
        }
      }),
      0
    );
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(JSON.parse(output[0] ?? ""), {
    state: "running",
    endpoint: "http://127.0.0.1:4100",
    pid: 42
  });
});

test("unmigrated runtime backends fail clearly instead of invoking wrappers", () => {
  for (const args of [
    ["router", "status"],
    ["provider", "claude"],
    ["hook", "skill-read"]
  ] as string[][]) {
    assert.throws(
      () => main(args),
      (error: unknown) => {
        assert.equal(error instanceof UnmigratedRuntimeError, true);
        assert.match(String(error), /runtime backend is not migrated/);
        return true;
      }
    );
  }
});

test("typed command boundaries reject unknown names and extra arguments", () => {
  assert.throws(() => runMain(["provider", "unknown"]), /unsupported provider/);
  assert.throws(() => runMain(["hook", "unknown"]), /unsupported hook/);
  assert.throws(
    () => runMain(["router", "unknown"]),
    /unsupported router command/
  );
  assert.equal(
    runMain(["install", "--check"], { install: { install: () => 17 } }),
    17
  );
});
