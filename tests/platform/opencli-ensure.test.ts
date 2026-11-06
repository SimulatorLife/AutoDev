import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureOpencliProxy,
  OPENCLI_PROXY_LABEL,
  resolveOpencliEnsureOptions
} from "@simulatorlife/autodev-runtime/platform/opencli-ensure";
import type { OptionalBridgeDeps } from "@simulatorlife/autodev-runtime/platform/optional-bridge-ensure";

function deps(overrides: Partial<OptionalBridgeDeps> = {}): OptionalBridgeDeps {
  return {
    launchd: {
      isLoaded: () => false,
      kickstart: () => {},
      bootstrap: () => {}
    },
    probe: async () => false,
    sleep: async () => {},
    startFallback: () => {},
    ...overrides
  };
}

test("resolver derives the opencli launchd paths and finds the pinned opencli dependency", () => {
  const options = resolveOpencliEnsureOptions({
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex"
  });
  assert.equal(options.label, OPENCLI_PROXY_LABEL);
  assert.equal(options.port, 4004);
  assert.equal(
    options.launcher,
    "/home/test/.codex/hooks/run-codex-opencli-proxy.sh"
  );
  assert.equal(
    options.plist,
    "/home/test/Library/LaunchAgents/com.codex.opencli-proxy.plist"
  );
  // opencli is a Runtime package dependency, so the lockfile install has it.
  assert.equal(options.available, true);
});

test("an explicit OPENCLI_BIN that is not executable makes opencli unavailable", () => {
  const options = resolveOpencliEnsureOptions({
    HOME: "/home/test",
    OPENCLI_BIN: "/nonexistent/opencli"
  });
  assert.equal(options.available, false);
});

test("missing opencli is an optional no-op and a loaded agent is kickstarted", async () => {
  const unavailable = resolveOpencliEnsureOptions({
    HOME: "/home/test",
    OPENCLI_BIN: "/nonexistent/opencli"
  });
  assert.equal(await ensureOpencliProxy(unavailable, deps()), true);

  const calls: string[] = [];
  let probes = 0;
  const ready = await ensureOpencliProxy(
    { ...unavailable, available: true, readyTimeoutMs: 20 },
    deps({
      launchd: {
        isLoaded: () => true,
        kickstart: (label) => {
          calls.push(`kickstart ${label}`);
        },
        bootstrap: () => {
          calls.push("bootstrap");
        }
      },
      probe: async () => ++probes > 1
    })
  );
  assert.equal(ready, true);
  assert.deepEqual(calls, [`kickstart ${OPENCLI_PROXY_LABEL}`]);
});
