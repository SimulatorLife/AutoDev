import assert from "node:assert/strict";
import test from "node:test";

import { runMain } from "@simulatorlife/autodev-runtime/cli";

/*
The operator's lease recovery.

The lease itself is proven in `runtime/tests/command-workspace-lease.test.ts`.
What is proven here is the command the operator reaches for: that it says
which state home it read, that it refuses a lease it cannot release, and
that `--force` is what releases one anyway.
*/

/*
Runs `runMain` with the CLI's own argument separator and returns stdout.
*/
async function capture(
  argv: string[],
  backends: Parameters<typeof runMain>[1]
): Promise<string> {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk).trimEnd());
    return true;
  }) as typeof process.stdout.write;
  try {
    await runMain(argv, backends);
  } finally {
    process.stdout.write = originalWrite;
  }
  return output.join("\n");
}

test("the lease listing says which state home it read", async () => {
  const output = await capture(["--", "lease", "list"], {
    lease: {
      location: "/tmp/autodev/run",
      list: () => ["abc123  held  holder 42 (running)  command 43 (running)"],
      release: () => ({ released: true, reason: "unused" })
    }
  });
  assert.match(output, /Run directory: \/tmp\/autodev\/run/u);
  assert.match(output, /abc123 {2}held/u);
});

test("a lease that cannot be released is refused, not reported as released", async () => {
  let capturedForce: boolean | null = null;
  const result = await runMain(["--", "lease", "release", "abc123"], {
    lease: {
      location: "/tmp/autodev/run",
      list: () => [],
      release: (_workspaceKey, isForced) => {
        capturedForce = isForced;
        return {
          released: false,
          reason: "the lease cannot be verified as abandoned"
        };
      }
    }
  });
  assert.equal(result, 1);
  assert.equal(capturedForce, false);
});

test("--force is what releases a lease the Runtime cannot prove is abandoned", async () => {
  const forced: boolean[] = [];
  const result = await runMain(
    ["--", "lease", "release", "abc123", "--force"],
    {
      lease: {
        location: "/tmp/autodev/run",
        list: () => [],
        release: (_workspaceKey, isForced) => {
          forced.push(isForced);
          return {
            released: true,
            reason: "released on the operator's authority"
          };
        }
      }
    }
  );
  assert.equal(result, 0);
  assert.deepEqual(forced, [true]);
});

test("releasing a lease without a workspace key says what is missing", async () => {
  await assert.rejects(
    async () =>
      runMain(["--", "lease", "release"], {
        lease: {
          location: "/tmp/autodev/run",
          list: () => [],
          release: () => ({ released: true, reason: "unused" })
        }
      }),
    /lease release requires a workspace key/u
  );
});
