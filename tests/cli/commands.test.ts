import assert from "node:assert/strict";
import test from "node:test";

import {
  runMain,
  UnmigratedRuntimeError
} from "@simulatorlife/autodev-runtime/cli";

test("CLI dispatches router, provider, hook, and install through typed backends", async () => {
  const calls: string[] = [];
  const result = await runMain(["router", "run"], {
    router: {
      run: () => {
        calls.push("router run");
        return 11;
      },
      ensure: () => {
        calls.push("router ensure");
        return 12;
      },
      status: () => ({ router: "running" })
    }
  });
  assert.equal(result, 11);
  assert.deepEqual(calls, ["router run"]);

  assert.equal(
    await runMain(["provider", "claude"], {
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
    await runMain(["hook", "skill-read"], {
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
    await runMain(["install"], {
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
    await runMain(["install", "--materialize-only"], {
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
    await runMain(["repo", "bootstrap", "--check"], {
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

test("CLI help uses the documented pnpm entrypoint", async () => {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk).trimEnd());
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await runMain(["--", "--help"]), 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(
    output.join("\n"),
    /^Usage: pnpm autodev -- <command> \[subcommand\] \[options\]/u
  );
});

test("documented pnpm argument separator reaches the check command", async () => {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk).trimEnd());
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await runMain(["--", "check"]), 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(output, [
    `AutoDev check passed on Node ${process.versions.node}`
  ]);
});

test("runMain reads process arguments when argv is omitted", async () => {
  const originalArgv = process.argv;
  const calls: string[] = [];
  process.argv = [...originalArgv.slice(0, 2), "--", "provider", "claude"];
  try {
    assert.equal(
      await runMain(undefined, {
        provider: {
          start: (name) => {
            calls.push(name);
            return 18;
          }
        }
      }),
      18
    );
  } finally {
    process.argv = originalArgv;
  }
  assert.deepEqual(calls, ["claude"]);
});

test("router status uses its typed status result", async () => {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  // Command output goes to stdout through @simulatorlife/autodev-runtime/shared/output.
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk).trimEnd());
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(
      await runMain(["router", "status"], {
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

test("unmigrated provider and hook backends fail clearly instead of invoking wrappers", async () => {
  for (const args of [
    ["provider", "claude"],
    ["hook", "skill-read"]
  ] as string[][]) {
    assert.throws(
      () => runMain(args),
      (error: unknown) => {
        assert.equal(error instanceof UnmigratedRuntimeError, true);
        assert.match(String(error), /runtime backend is not migrated/);
        return true;
      }
    );
  }
});

test("typed command boundaries reject unknown names and extra arguments", async () => {
  assert.throws(() => runMain(["provider", "unknown"]), /unsupported provider/);
  assert.throws(() => runMain(["hook", "unknown"]), /unsupported hook/);
  assert.throws(
    () => runMain(["router", "unknown"]),
    /unsupported router command/
  );
  assert.equal(
    await runMain(["install", "--check"], { install: { install: () => 17 } }),
    17
  );
});
