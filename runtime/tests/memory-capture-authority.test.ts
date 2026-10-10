import assert from "node:assert/strict";
import test from "node:test";

import {
  clearTrustedMemoryContextsForTest,
  injectOrchestratorMemory,
  trustedMemoryContextForSession
} from "../src/router/memory-injection.ts";

/**
 * The authority lookup the native capture route depends on.
 *
 * `trustedMemoryContextForSession` is what `POST /control/memory/capture` calls
 * to decide whether it may attribute a transcript to a workspace. The request
 * names its own session and its own `cwd`, so this is the only thing standing
 * between a caller and an envelope scoped to somebody else's workspace.
 *
 * Its revocation behaviour is already pinned, through `isTrustedSession` in
 * `memory-ablation-assignment.test.ts`. This is the other half: the same map,
 * read by the other function, with one check the first does not have — the
 * comparison goes through `path.resolve`, so what is compared is the resolved
 * directory rather than the string the router happened to be handed.
 *
 * That difference is the reason this file exists. `/repo/x`, `/repo/x/` and
 * `/repo/./x` are the same directory, and a router that recorded the first and a
 * hook that named the second must agree — while `/repo/xy` is a different
 * directory and must not. A raw string comparison gets the first pair wrong; a
 * prefix comparison gets the second wrong.
 *
 * The scope rules here are the ones a reader would otherwise have to infer from
 * the order of two guards, because the code used to carry two `sessionScope`
 * comparisons that compared `"identified"` to `"identified"` and could never
 * fire. See "a non-identified observation neither grants nor revokes trust".
 */

const WORKSPACE = {
  key: "SimulatorLife/AutoDev",
  workspace_id: "SimulatorLife/AutoDev",
  cwd: "/repo/autodev"
} as const;

const SESSION = "session-capture-authority";

/**
 * Register a session the way the router does. A `null` host returns after
 * registration, which is all this needs — the trust decision is made before
 * storage is consulted.
 */
async function register(
  sessionKey: string,
  workspace: { key: string; workspace_id: string; cwd: string },
  sessionScope = "identified"
): Promise<void> {
  await injectOrchestratorMemory(
    {
      payload: {
        model: "autodev/orchestrator",
        instructions: "Authoritative root policy.",
        input: [{ type: "message", role: "user", content: "Do the task." }]
      },
      requestId: "request-authority",
      sessionKey,
      sessionScope,
      threadId: "thread-authority",
      workspace
    },
    null
  );
}

/** Register the one session every case below starts from. */
async function withRegisteredSession(
  run: () => void | Promise<void>
): Promise<void> {
  clearTrustedMemoryContextsForTest();
  try {
    await register(SESSION, WORKSPACE);
    await run();
  } finally {
    clearTrustedMemoryContextsForTest();
  }
}

test("a session the router observed is trusted for the root it was observed in", async () => {
  await withRegisteredSession(async () => {
    const context = trustedMemoryContextForSession(SESSION, WORKSPACE.cwd);

    assert.ok(context, "a session the router just observed was not trusted");
    assert.equal(context.workspaceId, WORKSPACE.workspace_id);
    assert.equal(context.repositoryId, WORKSPACE.key);
    assert.equal(context.root, WORKSPACE.cwd);
    assert.equal(context.sessionScope, "identified");
  });
});

test("the same session against a different root is not trusted", async () => {
  // The capture request supplies its own `cwd`. Without this, a caller could name
  // any directory and have the envelope attributed to the trusted workspace.
  await withRegisteredSession(async () => {
    for (const root of [
      "/somewhere/else",
      "/repo/autodev/nested",
      // A sibling whose name starts with the trusted one. A prefix comparison
      // would accept this.
      "/repo/autodev-other",
      "/repo"
    ]) {
      assert.equal(
        trustedMemoryContextForSession(SESSION, root),
        null,
        `"${root}" was trusted for a session observed elsewhere`
      );
    }
  });
});

test("a session the router has never observed is not trusted", async () => {
  await withRegisteredSession(async () => {
    assert.equal(
      trustedMemoryContextForSession("session-never-seen", WORKSPACE.cwd),
      null,
      "an unobserved session was trusted"
    );
    assert.equal(trustedMemoryContextForSession("", WORKSPACE.cwd), null);
  });
});

test("a root that resolves to the trusted directory is trusted", async () => {
  // The `path.resolve` arm. These are the same directory spelled three ways, and
  // a router that recorded one and a hook that named another must agree — the
  // two come from different sources and neither is canonical on its own. A raw
  // string comparison would refuse all three.
  await withRegisteredSession(async () => {
    for (const root of [
      "/repo/autodev/",
      "/repo/autodev/.",
      "/repo/./autodev",
      "/repo/autodev/sub/.."
    ]) {
      const context = trustedMemoryContextForSession(SESSION, root);
      assert.ok(
        context,
        `"${root}" resolves to the trusted root but was refused`
      );
      assert.equal(
        context.root,
        WORKSPACE.cwd,
        "the recorded root was rewritten"
      );
    }
  });
});

test("a session revoked by a second workspace cannot be trusted again", async () => {
  // The property the `null` write buys. A guard that merely refused the
  // mismatched call — without recording it — would let the next request back
  // against the original workspace succeed, so the key would be usable again the
  // moment the caller changed its mind.
  await withRegisteredSession(async () => {
    await register(SESSION, { ...WORKSPACE, workspace_id: "other/workspace" });

    assert.equal(
      trustedMemoryContextForSession(SESSION, WORKSPACE.cwd),
      null,
      "a revoked session was trusted again by asking with the original root"
    );
  });
});

test("a non-identified observation neither grants nor revokes trust", async () => {
  // The rule the two dead `sessionScope` comparisons used to imply, stated
  // directly. An unidentified session is refused its own memory — but the
  // request says nothing about the identified session that shares the key, and
  // revoking on it would be a denial of service: the caller supplies its own
  // scope, so anyone who can name a key could destroy that key's capture with
  // an ordinary anonymous request.
  await withRegisteredSession(async () => {
    await register(SESSION, WORKSPACE, "unidentified");

    const context = trustedMemoryContextForSession(SESSION, WORKSPACE.cwd);
    assert.ok(
      context,
      "an unidentified request revoked trust the router had already granted"
    );
    assert.equal(context.sessionScope, "identified");

    // And it grants nothing on its own, which is the half that does matter.
    clearTrustedMemoryContextsForTest();
    await register(SESSION, WORKSPACE, "unidentified");
    assert.equal(
      trustedMemoryContextForSession(SESSION, WORKSPACE.cwd),
      null,
      "an unidentified session was granted trust"
    );
  });
});

test("a revoked session stays revoked, however it is re-registered", async () => {
  // Why revocation stays narrow. Once a conflict writes `null` the entry is
  // absorbing: the writer only runs when `isTrustedSession` already returned
  // true, and that returns false for a null entry. So a legitimate retry from
  // the original workspace cannot restore what one bad claim destroyed — which
  // is exactly why a caller-controlled signal is not allowed to trigger it.
  await withRegisteredSession(async () => {
    await register(SESSION, { ...WORKSPACE, workspace_id: "other/workspace" });
    await register(SESSION, WORKSPACE);
    await register(SESSION, WORKSPACE);

    assert.equal(
      trustedMemoryContextForSession(SESSION, WORKSPACE.cwd),
      null,
      "a revoked session was restored by re-registering the original workspace"
    );
  });
});

test("re-observing the same session in the same place keeps it trusted", async () => {
  // The other side of the revocation rule, and the one that matters for
  // availability. A router retries, a client reconnects, a proxy replays: the
  // same session arriving twice against the same workspace is normal traffic,
  // and revoking it would break every capture after the first.
  await withRegisteredSession(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await register(SESSION, WORKSPACE);
      const context = trustedMemoryContextForSession(SESSION, WORKSPACE.cwd);
      assert.ok(
        context,
        `attempt ${attempt + 1}: a repeated identical registration revoked the session`
      );
    }
  });
});

test("different sessions in the same workspace are tracked separately", async () => {
  // The map is keyed by session, so revoking one must not disturb another. A
  // workspace-wide revocation would be far more disruptive than the property is
  // worth, and it is the failure mode a single shared entry would produce.
  await withRegisteredSession(async () => {
    const other = "session-neighbour";
    await register(other, WORKSPACE);
    await register(SESSION, { ...WORKSPACE, workspace_id: "other/workspace" });

    assert.equal(
      trustedMemoryContextForSession(SESSION, WORKSPACE.cwd),
      null,
      "the revoked session was trusted again"
    );
    assert.ok(
      trustedMemoryContextForSession(other, WORKSPACE.cwd),
      "revoking one session disturbed another in the same workspace"
    );
  });
});

test("the map is bounded, and what it drops is the oldest", async () => {
  // A router is long-lived and every model request can name a new session key,
  // so an unbounded map here is a slow leak in the one process that cannot be
  // restarted to shed it. The bound is the property, so this checks the number
  // exactly rather than that "some were dropped" — a limit that drifted to
  // 4096 satisfies the looser wording just as well as one at 512, and the cost
  // of that drift is invisible until the process is large.
  await withRegisteredSession(async () => {
    const bound = 512;
    const total = bound + 8;

    for (let index = 0; index < total; index += 1) {
      await register(`session-lru-${index}`, WORKSPACE);
    }

    const oldestRetained = total - bound;
    assert.ok(
      trustedMemoryContextForSession(
        `session-lru-${oldestRetained}`,
        WORKSPACE.cwd
      ),
      `the map dropped session ${oldestRetained}, which it still had room for`
    );
    assert.equal(
      trustedMemoryContextForSession(
        `session-lru-${oldestRetained - 1}`,
        WORKSPACE.cwd
      ),
      null,
      "a session past the bound was kept, so the oldest is not what gets dropped"
    );
    assert.ok(
      trustedMemoryContextForSession(`session-lru-${total - 1}`, WORKSPACE.cwd),
      "the most recently observed session was evicted"
    );
  });
  // The repository-root map beside it carries the same shape at a bound of 256,
  // and no test here can reach it. Its resolver is module-private and
  // `createOrchestratorMemoryService` returns null without a live database, so
  // nothing exported lets a caller ask what root a workspace resolved to. That
  // is an observability limit, not agreement that the bound holds; the two loops
  // are edited together.
});
