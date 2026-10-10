import assert from "node:assert/strict";
import test from "node:test";

import {
  assignControlledAblationArm,
  clearTrustedMemoryContextsForTest,
  CONTROLLED_ABLATION_ARMS,
  injectOrchestratorMemory,
  isTrustedSession,
  resolveRouterMemoryMode,
  type RouterMemoryModeContext
} from "../src/router/memory-injection.ts";

/**
 * The controlled-ablation gates: who gets an arm, and what happens to everyone
 * who does not.
 *
 * `docs/memory-injection-outcome-evaluation.md` is exact about this contract
 * and nothing tested it. "Every request within the same trusted session maps to
 * the identical arm deterministically", bucketed over all four of
 * `(experimentId, workspaceId, repositoryId, sessionKey)`, "reproducible and
 * approximately even over many sessions". A hash that returned one arm for
 * everything, ignored the experiment ID, or re-rolled between requests inside a
 * session would each make an experiment's cohorts mean nothing -- and none of
 * the three produces an error. It just quietly produces data.
 *
 * The fail-closed half matters just as much: an experiment that cannot be
 * trusted must refuse the assignment rather than fall back to a default mode,
 * because the fallback is indistinguishable in the data from a real arm.
 */

const EXPERIMENT = "exp-2026-10";
const WORKSPACE_ID = "SimulatorLife/AutoDev";
const REPOSITORY_ID = "SimulatorLife/AutoDev";
const REPO_ROOT = "/repo/autodev";

const WORKSPACE = {
  key: REPOSITORY_ID,
  workspace_id: WORKSPACE_ID,
  cwd: REPO_ROOT
} as const;

function armFor(sessionKey: string): string {
  return assignControlledAblationArm(
    EXPERIMENT,
    sessionKey,
    WORKSPACE_ID,
    REPOSITORY_ID
  );
}

test("one session is always assigned the same arm", () => {
  // The load-bearing property. Re-rolling between requests inside a session
  // would split that session's injections across arms, which is precisely the
  // comparison the experiment exists to make.
  const first = armFor("session-stable");
  for (let attempt = 0; attempt < 25; attempt += 1) {
    assert.equal(armFor("session-stable"), first);
  }
  assert.ok(
    CONTROLLED_ABLATION_ARMS.includes(
      first as (typeof CONTROLLED_ABLATION_ARMS)[number]
    ),
    `assigned an arm outside the documented set: ${first}`
  );
});

test("bucketing spreads sessions across all three arms", () => {
  // "Approximately even over many sessions", not a fixed-size balanced
  // allocation. A hash that collapsed onto one arm still assigns *an* arm
  // deterministically, so only a distribution check catches it.
  const counts = new Map<string, number>();
  const sessions = 3000;
  for (let index = 0; index < sessions; index += 1) {
    const arm = armFor(`session-${index}`);
    counts.set(arm, (counts.get(arm) ?? 0) + 1);
  }

  assert.deepEqual(
    [...counts.keys()].sort(),
    [...CONTROLLED_ABLATION_ARMS].sort(),
    "every documented arm must be reachable, and no other may be"
  );
  for (const arm of CONTROLLED_ABLATION_ARMS) {
    const share = (counts.get(arm) ?? 0) / sessions;
    assert.ok(
      share > 0.28 && share < 0.39,
      `${arm} took ${(share * 100).toFixed(1)}% of sessions, which is not approximately even`
    );
  }
});

test("every one of the four bucketing inputs changes the assignment", () => {
  // The spec names all four. An input the hash ignored would leave a whole class
  // of sessions indistinguishable -- two experiments in one repository, say,
  // would share arms and their cohorts would merge.
  const vary = (index: number): string => armFor(`session-vary-${index}`);

  const spread = (arms: readonly string[]): boolean => new Set(arms).size > 1;

  assert.ok(
    spread(Array.from({ length: 60 }, (_, i) => vary(i))),
    "varying the session key must change the arm for some sessions"
  );
  assert.ok(
    spread(
      Array.from({ length: 60 }, (_, i) =>
        assignControlledAblationArm(
          `experiment-${i}`,
          "session-fixed",
          WORKSPACE_ID,
          REPOSITORY_ID
        )
      )
    ),
    "the experiment ID must be inside the hash, or two experiments merge"
  );
  assert.ok(
    spread(
      Array.from({ length: 60 }, (_, i) =>
        assignControlledAblationArm(
          EXPERIMENT,
          "session-fixed",
          `${WORKSPACE_ID}-${i}`,
          REPOSITORY_ID
        )
      )
    ),
    "the workspace must be inside the hash"
  );
  assert.ok(
    spread(
      Array.from({ length: 60 }, (_, i) =>
        assignControlledAblationArm(
          EXPERIMENT,
          "session-fixed",
          WORKSPACE_ID,
          `${REPOSITORY_ID}-${i}`
        )
      )
    ),
    "the repository must be inside the hash"
  );
});

test("the bucketing inputs are separated, so one cannot stand in for another", () => {
  // The parts are joined on NUL precisely so that shifting a character across a
  // boundary changes the hash. With a plain join, these two are the same string
  // and an operator's experiment ID could be chosen to collide with a
  // neighbouring workspace.
  // The parts are joined on NUL precisely so that an input cannot impersonate a
  // boundary. With a plain separator these two hash the same string, so one
  // field's contents could be read as two fields.
  //
  // The inputs here contain the separator on purpose. A realistic experiment ID
  // cannot -- the pattern forbids it, which is why an operator cannot trigger
  // this -- but `assignControlledAblationArm` is a pure function over raw
  // strings and makes no such promise, so the guarantee is pinned here rather
  // than assumed.
  const left = Array.from({ length: 20 }, (_, i) =>
    assignControlledAblationArm("a|b", `s-${i}`, "ws", "repo")
  );
  const right = Array.from({ length: 20 }, (_, i) =>
    assignControlledAblationArm("a", `s-${i}`, "b|ws", "repo")
  );

  assert.notDeepEqual(
    left,
    right,
    "shifting a separator between inputs must change the assignment"
  );
});

/** A context the gates accept, for isolating one gate at a time. */
function context(
  // Written out rather than `Partial<RouterMemoryModeContext>`: these fixtures
  // deliberately pass `undefined` for "absent", which `exactOptionalPropertyTypes`
  // will not accept through an optional property.
  overrides: {
    readonly sessionKey?: string | null | undefined;
    readonly sessionScope?: string | null | undefined;
    readonly workspace?: RouterMemoryModeContext["workspace"] | undefined;
  } = {}
): RouterMemoryModeContext {
  const sessionKey =
    "sessionKey" in overrides ? overrides.sessionKey : "session-gate";
  const sessionScope =
    "sessionScope" in overrides ? overrides.sessionScope : "identified";
  const workspace = "workspace" in overrides ? overrides.workspace : WORKSPACE;
  // Built member by member rather than spread, so an explicitly-undefined member
  // is *omitted* instead of being assigned `undefined` -- which is what the
  // gates read, and what `exactOptionalPropertyTypes` refuses to express.
  return {
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(sessionScope === undefined ? {} : { sessionScope }),
    ...(workspace === undefined ? {} : { workspace })
  };
}

function env(
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return {
    AUTODEV_MEMORY_ABLATION: "1",
    AUTODEV_MEMORY_EXPERIMENT_ID: EXPERIMENT,
    ...overrides
  } as NodeJS.ProcessEnv;
}

test("an experiment that is trusted end to end assigns an arm", () => {
  const mode = resolveRouterMemoryMode(env(), context());

  assert.ok(
    (CONTROLLED_ABLATION_ARMS as readonly string[]).includes(mode),
    `a trusted experiment must assign an arm, not ${mode}`
  );
});

test("no experiment configured leaves AUTODEV_MEMORY_MODE in charge", () => {
  assert.equal(
    resolveRouterMemoryMode(
      { AUTODEV_MEMORY_MODE: "jit" } as NodeJS.ProcessEnv,
      context()
    ),
    "jit"
  );
  // An unset mode is jit, not a refusal: the ordinary case must not need config.
  assert.equal(
    resolveRouterMemoryMode({} as NodeJS.ProcessEnv, context()),
    "jit"
  );
});

test("an experiment without the ablation gate is refused, not defaulted", () => {
  // The distinction that makes this worth a test: falling back to the
  // configured mode would be indistinguishable in the data from an arm, and the
  // operator's experiment would appear to run while never comparing anything.
  assert.equal(
    resolveRouterMemoryMode(env({ AUTODEV_MEMORY_ABLATION: "0" }), context()),
    "invalid"
  );
});

test("a malformed experiment ID is refused", () => {
  // `/^[a-z\d][a-z\d._-]{0,127}$/iu`: 1-128 characters, starting alphanumeric.
  for (const bad of [
    "-leading-dash",
    ".leading-dot",
    "has space",
    "has/slash",
    "a".repeat(129)
  ]) {
    assert.equal(
      resolveRouterMemoryMode(
        env({ AUTODEV_MEMORY_EXPERIMENT_ID: bad }),
        context()
      ),
      "invalid",
      `${JSON.stringify(bad)} must not name an experiment`
    );
  }
  // The boundary itself is allowed, so this is not a length rule in disguise.
  assert.notEqual(
    resolveRouterMemoryMode(
      env({ AUTODEV_MEMORY_EXPERIMENT_ID: `a${"b".repeat(127)}` }),
      context()
    ),
    "invalid"
  );
});

test("a blank experiment ID means no experiment, not a refusal", () => {
  // Worth stating because it is the one gate that does *not* fail closed. An
  // operator who exports `AUTODEV_MEMORY_EXPERIMENT_ID=` -- which a shell will
  // happily do with an unset variable -- gets the default jit arm and an
  // experiment that never ran, rather than a refusal that would have told them.
  for (const blank of ["", "   "]) {
    assert.equal(
      resolveRouterMemoryMode(
        env({ AUTODEV_MEMORY_EXPERIMENT_ID: blank }),
        context()
      ),
      "jit",
      `${JSON.stringify(blank)} should read as no experiment configured`
    );
  }
});

test("an experiment over an untrusted workspace is refused", () => {
  // An arm must never be assigned to a workspace whose identity has not been
  // established, because the arm then flows into a repository root nobody
  // verified.
  for (const workspace of [
    null,
    undefined,
    { key: "", workspace_id: WORKSPACE_ID, cwd: REPO_ROOT },
    { key: "unknown", workspace_id: WORKSPACE_ID, cwd: REPO_ROOT },
    // A relative cwd is not an identity.
    { key: REPOSITORY_ID, workspace_id: WORKSPACE_ID, cwd: "repo/relative" },
    { key: REPOSITORY_ID, workspace_id: WORKSPACE_ID }
  ]) {
    assert.equal(
      resolveRouterMemoryMode(env(), context({ workspace })),
      "invalid",
      `workspace ${JSON.stringify(workspace)} must not receive an arm`
    );
  }
});

test("an experiment without a real session key is refused", () => {
  // `process-scope` is shared by every session in the process, so bucketing on
  // it would put unrelated work in the same arm. A missing key must not fall
  // back to the request id either -- that would re-roll per request.
  for (const sessionKey of [null, undefined, "", "  ", "process-scope"]) {
    assert.equal(
      resolveRouterMemoryMode(env(), context({ sessionKey })),
      "invalid",
      `session key ${JSON.stringify(sessionKey)} must not receive an arm`
    );
  }
});

/**
 * Session trust, and the one place it looks wrong but is not.
 *
 * `isTrustedSession` returns false for a session it has *revoked* (a key it has
 * seen before against a different workspace or scope) and true for one it has
 * never seen, because trust is established on first sight inside an absolute
 * workspace and registered by the caller. Read quickly that looks like an
 * inverted check, and "fixing" it would refuse every first request of every
 * session -- so it is pinned deliberately.
 */
test("a session that was seen against another workspace is revoked", async () => {
  clearTrustedMemoryContextsForTest();
  try {
    const register = (sessionKey: string, workspace: typeof WORKSPACE) =>
      injectOrchestratorMemory(
        {
          // A user message is required: the router returns before it records a
          // trusted session when there is no task to attribute one to.
          payload: {
            model: "m",
            instructions: "policy",
            input: [{ type: "message", role: "user", content: "Do the task." }]
          },
          requestId: "request-trust",
          sessionKey,
          sessionScope: "identified",
          threadId: "thread-trust",
          workspace
        },
        // A null host returns after registration, which is all this needs.
        null
      );

    await register("session-shared", WORKSPACE);
    assert.equal(
      isTrustedSession("session-shared", "identified", WORKSPACE),
      true,
      "the workspace it was registered against must stay trusted"
    );
    assert.equal(
      isTrustedSession("session-shared", "identified", {
        ...WORKSPACE,
        cwd: "/somewhere/else"
      }),
      false,
      "the same key against a different root must be refused"
    );
    assert.equal(
      isTrustedSession("session-shared", "identified", {
        ...WORKSPACE,
        workspace_id: "other/workspace"
      }),
      false,
      "the same key against a different workspace id must be refused"
    );
    assert.equal(
      isTrustedSession("session-shared", "unidentified", WORKSPACE),
      false,
      "the same key under a different scope must be refused"
    );

    // Revocation is permanent, and that is what writing the `null` does. A
    // guard that merely refused the mismatched call -- without recording it --
    // would let the next call back against the original workspace succeed, so
    // the key would be usable again the moment the caller changed its mind.
    assert.equal(
      isTrustedSession("session-shared", "identified", WORKSPACE),
      false,
      "a revoked key must not become trusted again by asking with the original workspace"
    );
    assert.equal(
      isTrustedSession("session-shared", "identified", {
        ...WORKSPACE,
        cwd: "/somewhere/else"
      }),
      false
    );
  } finally {
    clearTrustedMemoryContextsForTest();
  }
});

test("trust requires an identified session with a usable workspace", () => {
  clearTrustedMemoryContextsForTest();
  assert.equal(isTrustedSession(null, "identified", WORKSPACE), false);
  assert.equal(isTrustedSession("", "identified", WORKSPACE), false);
  assert.equal(isTrustedSession("   ", "identified", WORKSPACE), false);
  // The scope is what distinguishes a real session from a shared process.
  assert.equal(isTrustedSession("session-x", "unidentified", WORKSPACE), false);
  assert.equal(isTrustedSession("session-x", null, WORKSPACE), false);
  assert.equal(
    isTrustedSession("session-x", "process-scope", WORKSPACE),
    false
  );
  // An over-long key is refused rather than stored.
  assert.equal(
    isTrustedSession("k".repeat(257), "identified", WORKSPACE),
    false
  );
  // And the workspace is re-checked here, not only at registration.
  assert.equal(isTrustedSession("session-x", "identified", null), false);
  assert.equal(
    isTrustedSession("session-x", "identified", {
      key: "unknown",
      cwd: REPO_ROOT
    }),
    false
  );
  assert.equal(
    isTrustedSession("session-x", "identified", {
      key: REPOSITORY_ID,
      cwd: "relative"
    }),
    false
  );
});
