import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  findSessionRollouts,
  listRecentSessions,
  listRecentSessionsResponse,
  readHeadMeta,
  rolloutFiles,
  rolloutRoots
} from "../../src/diagnostics/rollout-discovery.ts";
import { CHILD, fixture, OTHER, ROOT } from "./fixture.ts";

test("a thread id finds its whole session, and a session id finds its subagents", () => {
  const { sessionsRoot, cleanup } = fixture();
  try {
    const fromChild = findSessionRollouts(sessionsRoot, CHILD).map((file) =>
      file.includes(ROOT) ? "root" : file.includes(CHILD) ? "child" : "other"
    );
    assert.deepEqual(fromChild.sort(), ["child", "root"]);

    const fromRoot = findSessionRollouts(sessionsRoot, ROOT).map((file) =>
      file.includes(CHILD) ? "child" : file.includes(ROOT) ? "root" : "other"
    );
    assert.deepEqual(fromRoot.sort(), ["child", "root"]);
  } finally {
    cleanup();
  }
});

test("an archived session is found under the archived root", () => {
  const { sessionsRoot, archivedRoot, cleanup } = fixture();
  try {
    const archived = findSessionRollouts(
      archivedRoot,
      "01a0b6aa-0000-7000-8000-000000000004"
    );
    assert.equal(archived.length, 1);
    const active = findSessionRollouts(
      sessionsRoot,
      "01a0b6aa-0000-7000-8000-000000000004"
    );
    assert.deepEqual(active, []);
  } finally {
    cleanup();
  }
});

test("an id that matches no rollout finds nothing", () => {
  const { sessionsRoot, cleanup } = fixture();
  try {
    assert.deepEqual(
      findSessionRollouts(sessionsRoot, "01a0b6ff-0000-7000-8000-000000000009"),
      []
    );
  } finally {
    cleanup();
  }
});

test("an invalid session identity is refused before the filesystem is read", () => {
  const { sessionsRoot, cleanup } = fixture();
  try {
    assert.deepEqual(findSessionRollouts(sessionsRoot, "process-fallback"), []);
    assert.deepEqual(findSessionRollouts(sessionsRoot, "unknown"), []);
  } finally {
    cleanup();
  }
});

test("both rollout roots are searched, and a root that does not exist is not an error", () => {
  const { home, sessionsRoot, archivedRoot, cleanup } = fixture();
  try {
    assert.deepEqual(rolloutRoots(home), [sessionsRoot, archivedRoot]);
    assert.deepEqual(rolloutFiles(path.join(home, "nope")), []);
    const acrossRoots = findSessionRollouts(
      [sessionsRoot, archivedRoot],
      "01a0b6aa-0000-7000-8000-000000000004"
    );
    assert.equal(acrossRoots.length, 1);
  } finally {
    cleanup();
  }
});

test("the head meta carries the join key without loading the whole rollout", () => {
  const { sessionsRoot, cleanup } = fixture();
  try {
    const files = rolloutFiles(sessionsRoot);
    const root = files.find((file) => file.includes(ROOT));
    assert.ok(root);
    const meta = readHeadMeta(root);
    assert.equal(meta?.id, ROOT);
    assert.equal(meta?.session_id, ROOT);
    assert.equal(meta?.cwd, "/tmp/repo");
  } finally {
    cleanup();
  }
});

test("the recent-sessions listing groups the threads of one session", () => {
  const { sessionsRoot, archivedRoot, cleanup } = fixture();
  try {
    const recent = listRecentSessions([sessionsRoot, archivedRoot], 10);
    const ids = new Set(recent.map((session) => session.id));
    assert.ok(ids.has(ROOT));
    assert.ok(ids.has(OTHER));
    assert.ok(ids.has("01a0b6aa-0000-7000-8000-000000000004"));
    const root = recent.find((session) => session.id === ROOT);
    assert.equal(root?.threads, 2);
    assert.equal(root?.cwd, "/tmp/repo");
  } finally {
    cleanup();
  }
});

test("the recent-sessions response carries the contract's schema and limit", () => {
  const { sessionsRoot, archivedRoot, cleanup } = fixture();
  try {
    const response = listRecentSessionsResponse(
      [sessionsRoot, archivedRoot],
      2
    );
    assert.equal(response.schema, "autodev-session-recent-v1");
    assert.equal(response.limit, 2);
    assert.equal(response.sessions.length, 2);
  } finally {
    cleanup();
  }
});
