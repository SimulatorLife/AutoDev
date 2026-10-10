import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultPlaytestArtifactsRoot,
  PlaytestArtifactConfigurationError,
  PlaytestArtifactExpiredError,
  PlaytestArtifactFormatError,
  PlaytestArtifactIntegrityError,
  PlaytestArtifactMissingError,
  PlaytestArtifactNotAuthorizedError,
  PlaytestArtifactOversizedError,
  PlaytestArtifactStore
} from "../src/playtesting/artifact-store.ts";

function createTempDir(prefix: string): {
  readonly root: string;
  readonly cleanup: () => void;
} {
  const raw = mkdtempSync(path.join(tmpdir(), prefix));
  const root = realpathSync(raw);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test("PlaytestArtifactStore constructor validates workspace, root, and owner permissions", () => {
  const { root, cleanup } = createTempDir("artifact-store-init-");
  try {
    // Rejects invalid workspaceId formats
    assert.throws(
      () =>
        new PlaytestArtifactStore({
          rootDirectory: root,
          workspaceId: "invalid"
        }),
      PlaytestArtifactConfigurationError
    );
    assert.throws(
      () =>
        new PlaytestArtifactStore({
          rootDirectory: root,
          workspaceId: "../traversal"
        }),
      PlaytestArtifactConfigurationError
    );
    assert.throws(
      () =>
        new PlaytestArtifactStore({
          rootDirectory: root,
          workspaceId: "owner/../escaped"
        }),
      PlaytestArtifactConfigurationError
    );

    // Rejects non-existent root directory when explicitly supplied
    assert.throws(
      () =>
        new PlaytestArtifactStore({
          rootDirectory: path.join(root, "non-existent"),
          workspaceId: "test-owner/test-repo"
        }),
      PlaytestArtifactConfigurationError
    );

    // Rejects relative rootDirectory
    assert.throws(
      () =>
        new PlaytestArtifactStore({
          rootDirectory: "relative/path",
          workspaceId: "test-owner/test-repo"
        }),
      PlaytestArtifactConfigurationError
    );

    // Valid constructor binds workspace and creates workspace directory with 0o700 mode
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "test-owner/test-repo"
    });
    assert.equal(store.boundWorkspaceId(), "test-owner/test-repo");
    assert.equal(store.rootDirectory(), root);

    const wsDir = path.join(root, "test-owner", "test-repo");
    assert.ok(existsSync(wsDir));
    const stat = statSync(wsDir);
    assert.equal(stat.mode & 0o777, 0o700);
  } finally {
    cleanup();
  }
});

test("PlaytestArtifactStore rejects symlink rootDirectory", () => {
  const { root, cleanup } = createTempDir("artifact-store-symlink-root-");
  try {
    const realDir = path.join(root, "real");
    mkdirSync(realDir, 0o700);
    const symlinkPath = path.join(root, "symlink-dir");
    symlinkSync(realDir, symlinkPath, "dir");

    assert.throws(
      () =>
        new PlaytestArtifactStore({
          rootDirectory: symlinkPath,
          workspaceId: "test-owner/test-repo"
        }),
      PlaytestArtifactConfigurationError
    );
  } finally {
    cleanup();
  }
});

test("PlaytestArtifactStore defaults to CODEX_HOME/playtesting/artifacts", () => {
  const { root, cleanup } = createTempDir("artifact-store-default-root-");
  const originalCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = root;
    assert.equal(
      defaultPlaytestArtifactsRoot(),
      path.join(root, "playtesting", "artifacts")
    );

    const store = new PlaytestArtifactStore({
      workspaceId: "test-owner/test-repo"
    });
    assert.equal(
      store.rootDirectory(),
      realpathSync(path.join(root, "playtesting", "artifacts"))
    );
  } finally {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    cleanup();
  }
});

test("referenceForId resolves only opaque metadata inside its workspace", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-artifact-ref-"));
  try {
    const store = new PlaytestArtifactStore({
      workspaceId: "owner/game",
      rootDirectory: root
    });
    const written = store.writeWindow({
      entries: [{ step: 1, action: "wait" }]
    });
    assert.deepEqual(
      store.referenceForId(written.reference.artifactId),
      written.reference
    );
    assert.equal(store.referenceForId("../outside"), null);
    assert.equal(store.referenceForId("unknown-artifact"), null);

    const otherWorkspace = new PlaytestArtifactStore({
      workspaceId: "owner/other",
      rootDirectory: root
    });
    assert.equal(
      otherWorkspace.referenceForId(written.reference.artifactId),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic and idempotent content writes for blobs and windows", () => {
  const { root, cleanup } = createTempDir("artifact-store-idempotent-");
  try {
    const nowTime = 1_000_000;
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "acme/racing-game",
      now: () => nowTime
    });

    const payload = new TextEncoder().encode("replay-trace-data-frame-1");
    const writeResult1 = store.writeArtifact({
      mediaType: "application/octet-stream",
      bytes: payload
    });

    assert.ok(writeResult1.reference.artifactId);
    assert.equal(writeResult1.reference.bytes, payload.byteLength);
    assert.equal(writeResult1.reference.mediaType, "application/octet-stream");
    assert.equal(writeResult1.createdAt, 1_000_000);

    // Reading the artifact verifies content and returns matching bytes
    const readResult1 = store.readArtifact(writeResult1.reference);
    assert.deepEqual(readResult1.bytes, payload);
    assert.equal(
      readResult1.reference.artifactId,
      writeResult1.reference.artifactId
    );

    // Idempotent write with exact same content returns same reference
    const writeResult2 = store.writeArtifact({
      mediaType: "application/octet-stream",
      bytes: payload
    });
    assert.equal(
      writeResult2.reference.artifactId,
      writeResult1.reference.artifactId
    );
    assert.equal(writeResult2.createdAt, writeResult1.createdAt);

    // Window write is also atomic and idempotent
    const windowEntries = [
      { step: 1, action: "steer-left", reward: 0.5 },
      { step: 2, action: "accelerate", reward: 1 }
    ];
    const windowResult1 = store.writeWindow({
      entries: windowEntries
    });
    assert.equal(windowResult1.lineCount, 2);

    const windowRead1 = store.readWindow(windowResult1.reference);
    assert.equal(windowRead1.lineCount, 2);
    const lines = new TextDecoder()
      .decode(windowRead1.bytes)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(lines, windowEntries);

    // Writing identical window is idempotent
    const windowResult2 = store.writeWindow({
      entries: windowEntries
    });
    assert.equal(
      windowResult2.reference.artifactId,
      windowResult1.reference.artifactId
    );

    // Writing same artifactId with different content fails integrity verification
    assert.throws(
      () =>
        store.writeArtifact({
          artifactId: writeResult1.reference.artifactId,
          mediaType: "application/octet-stream",
          bytes: new TextEncoder().encode("different-content")
        }),
      PlaytestArtifactIntegrityError
    );
  } finally {
    cleanup();
  }
});

test("content tamper and hash mismatch detection", () => {
  const { root, cleanup } = createTempDir("artifact-store-tamper-");
  try {
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "acme/racing-game"
    });

    const payload = new TextEncoder().encode("original-unmodified-content");
    const writeResult = store.writeArtifact({
      mediaType: "text/plain",
      bytes: payload
    });

    assert.equal(store.state(writeResult.reference), "present");

    // Tamper with on-disk blob bytes
    const sha256 = writeResult.reference.sha256;
    const blobFile = path.join(
      root,
      "acme",
      "racing-game",
      "blobs",
      sha256.slice(0, 2),
      sha256
    );
    assert.ok(existsSync(blobFile));
    writeFileSync(
      blobFile,
      new TextEncoder().encode("tampered-tampered-content!!")
    );

    // State reflects corrupted
    assert.equal(store.state(writeResult.reference), "corrupted");

    // Reading throws PlaytestArtifactIntegrityError
    assert.throws(
      () => store.readArtifact(writeResult.reference),
      PlaytestArtifactIntegrityError
    );

    // Tamper with window on disk
    const windowResult = store.writeWindow({
      entries: [{ step: 1, event: "start" }]
    });
    const windowFile = path.join(
      root,
      "acme",
      "racing-game",
      "windows",
      `${windowResult.reference.artifactId}.jsonl`
    );
    assert.ok(existsSync(windowFile));
    writeFileSync(windowFile, new TextEncoder().encode('{"tampered":true}\n'));

    assert.equal(store.state(windowResult.reference), "corrupted");
    assert.throws(
      () => store.readWindow(windowResult.reference),
      PlaytestArtifactIntegrityError
    );
  } finally {
    cleanup();
  }
});

test("duplicate refs sharing blob content and independent deletion", () => {
  const { root, cleanup } = createTempDir("artifact-store-duplicate-refs-");
  try {
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "acme/racing-game"
    });

    const bytes = new TextEncoder().encode("shared-content-between-refs");
    const ref1 = store.writeArtifact({
      artifactId: "ref-alpha",
      mediaType: "application/octet-stream",
      bytes
    }).reference;

    const ref2 = store.writeArtifact({
      artifactId: "ref-beta",
      mediaType: "application/octet-stream",
      bytes
    }).reference;

    assert.equal(ref1.sha256, ref2.sha256);
    assert.notEqual(ref1.artifactId, ref2.artifactId);

    // Both read successfully
    assert.deepEqual(store.readArtifact(ref1).bytes, bytes);
    assert.deepEqual(store.readArtifact(ref2).bytes, bytes);

    // Remove ref1: backing blob is preserved because ref2 still points to it
    const removeResult1 = store.remove(ref1);
    assert.equal(removeResult1.removed, true);
    assert.equal(store.state(ref1), "not-authorized");
    assert.equal(store.state(ref2), "present");
    assert.deepEqual(store.readArtifact(ref2).bytes, bytes);

    // Remove ref2: now backing blob is removed
    const removeResult2 = store.remove(ref2);
    assert.equal(removeResult2.removed, true);
    assert.equal(store.state(ref2), "not-authorized");

    const blobFile = path.join(
      root,
      "acme",
      "racing-game",
      "blobs",
      ref1.sha256.slice(0, 2),
      ref1.sha256
    );
    assert.equal(existsSync(blobFile), false);
  } finally {
    cleanup();
  }
});

test("workspace isolation enforces authorization boundaries", () => {
  const { root, cleanup } = createTempDir("artifact-store-isolation-");
  try {
    const storeA = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "org-a/project-1"
    });
    const storeB = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "org-b/project-2"
    });

    const blobPayload = new TextEncoder().encode("org-a-private-trace");
    const refA = storeA.writeArtifact({
      mediaType: "application/octet-stream",
      bytes: blobPayload
    }).reference;

    const windowRefA = storeA.writeWindow({
      entries: [{ secret: "org-a-step" }]
    }).reference;

    // Store B cannot read store A's blob
    assert.equal(storeB.state(refA), "not-authorized");
    assert.throws(
      () => storeB.readArtifact(refA),
      PlaytestArtifactNotAuthorizedError
    );

    // Store B cannot read store A's window
    assert.equal(storeB.state(windowRefA), "not-authorized");
    assert.throws(
      () => storeB.readWindow(windowRefA),
      PlaytestArtifactNotAuthorizedError
    );

    // Store B cannot remove store A's artifact
    const removeResult = storeB.remove(refA);
    assert.equal(removeResult.removed, false);
    assert.equal(removeResult.reason, "not-authorized");

    // Store A can still read its own artifact
    assert.deepEqual(storeA.readArtifact(refA).bytes, blobPayload);
  } finally {
    cleanup();
  }
});

test("path traversal and malicious artifact id rejection", () => {
  const { root, cleanup } = createTempDir("artifact-store-traversal-");
  try {
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "trusted/workspace"
    });

    // Invalid/traversal artifactId in writeArtifact
    assert.throws(
      () =>
        store.writeArtifact({
          artifactId: "../escaped",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("bad")
        }),
      PlaytestArtifactFormatError
    );

    assert.throws(
      () =>
        store.writeArtifact({
          artifactId: "../../etc/passwd",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("bad")
        }),
      PlaytestArtifactFormatError
    );

    // Calling readArtifact with traversal artifactId
    const traversalRef = {
      artifactId: "../../etc/shadow",
      sha256: "0".repeat(64),
      bytes: 10,
      mediaType: "text/plain"
    };
    assert.equal(store.state(traversalRef), "not-authorized");
    assert.throws(
      () => store.readArtifact(traversalRef),
      PlaytestArtifactNotAuthorizedError
    );
  } finally {
    cleanup();
  }
});

test("symlink escape prevention on storage files", () => {
  const { root, cleanup } = createTempDir("artifact-store-symlink-escape-");
  try {
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "test-org/repo"
    });

    const payload = new TextEncoder().encode("valid-content");
    const writeResult = store.writeArtifact({
      mediaType: "text/plain",
      bytes: payload
    });

    // Replace the blob file with a symlink to an outside file
    const sha256 = writeResult.reference.sha256;
    const blobFile = path.join(
      root,
      "test-org",
      "repo",
      "blobs",
      sha256.slice(0, 2),
      sha256
    );
    const outsideFile = path.join(root, "outside-secret.txt");
    writeFileSync(outsideFile, "secret-outside-content\n");

    unlinkSync(blobFile);
    symlinkSync(outsideFile, blobFile);

    // Reading the symlinked file must fail with configuration error, not leak content
    assert.throws(
      () => store.readArtifact(writeResult.reference),
      PlaytestArtifactConfigurationError
    );
  } finally {
    cleanup();
  }
});

test("enforces maximum payload and window line limits", () => {
  const { root, cleanup } = createTempDir("artifact-store-bounds-");
  try {
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "limits/test",
      maxBytes: 1024,
      maxWindowLineBytes: 100,
      maxWindowBytes: 500,
      maxWindowSteps: 3
    });

    // Blob payload larger than maxBytes
    assert.throws(
      () =>
        store.writeArtifact({
          mediaType: "application/octet-stream",
          bytes: new Uint8Array(2000)
        }),
      PlaytestArtifactOversizedError
    );

    // Window line exceeding maxWindowLineBytes
    const longString = "x".repeat(150);
    assert.throws(
      () =>
        store.writeWindow({
          entries: [{ line: longString }]
        }),
      PlaytestArtifactOversizedError
    );

    // Window total steps exceeding maxWindowSteps
    assert.throws(
      () =>
        store.writeWindow({
          entries: [1, 2, 3, 4]
        }),
      PlaytestArtifactOversizedError
    );
  } finally {
    cleanup();
  }
});

test("partial evidence preservation on failed window writes", () => {
  const { root, cleanup } = createTempDir("artifact-store-partial-");
  try {
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "partial/evidence",
      maxWindowLineBytes: 50
    });

    const entries = [
      { step: 1, text: "valid line 1" },
      { step: 2, text: "valid line 2" },
      { step: 3, text: "x".repeat(100) } // Exceeds 50 bytes line limit
    ];

    // Writing fails on step 3
    assert.throws(
      () => store.writeWindow({ entries }),
      PlaytestArtifactOversizedError
    );

    // A .tmp scratch file must exist in windows directory containing the first 2 lines
    const windowsDir = path.join(root, "partial", "evidence", "windows");
    assert.ok(existsSync(windowsDir));
    const tmpFiles = readdirSync(windowsDir).filter((f) => f.includes(".tmp."));
    assert.ok(
      tmpFiles.length > 0,
      "At least one .tmp scratch file must be preserved"
    );
    const firstTmp = tmpFiles[0];
    assert.ok(firstTmp !== undefined);

    const scratchContent = readFileSync(
      path.join(windowsDir, firstTmp),
      "utf8"
    );
    assert.ok(scratchContent.includes("valid line 1"));
    assert.ok(scratchContent.includes("valid line 2"));

    // Check permissions on the scratch file (0o600)
    const scratchStat = statSync(path.join(windowsDir, firstTmp));
    assert.equal(scratchStat.mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test("human responses are blocked from generic LLM store", () => {
  const { root, cleanup } = createTempDir("artifact-store-human-blocked-");
  try {
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "test/human-check"
    });

    // Rejects human response media type
    assert.throws(
      () =>
        store.writeArtifact({
          mediaType: "application/x-autodev-human-response+json",
          bytes: new TextEncoder().encode("{}")
        }),
      PlaytestArtifactFormatError
    );

    // Rejects participant response schema in window entry
    assert.throws(
      () =>
        store.writeWindow({
          entries: [
            {
              schema: "autodev-human-experience-response-v1",
              pseudonymousParticipantId: "p-42",
              enjoyment: 3
            }
          ]
        }),
      PlaytestArtifactFormatError
    );
  } finally {
    cleanup();
  }
});

test("missing and expired states with explicit error classes", () => {
  const { root, cleanup } = createTempDir("artifact-store-states-");
  try {
    let now = 1_000_000;
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "test/states",
      retentionMs: 50_000,
      now: () => now
    });

    const ref = store.writeArtifact({
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("temporary-item")
    }).reference;

    assert.equal(store.state(ref), "present");

    // Manually delete blob to simulate missing state
    const blobFile = path.join(
      root,
      "test",
      "states",
      "blobs",
      ref.sha256.slice(0, 2),
      ref.sha256
    );
    unlinkSync(blobFile);

    assert.equal(store.state(ref), "missing");
    assert.throws(() => store.readArtifact(ref), PlaytestArtifactMissingError);

    // Advance clock past retention window
    now = 1_060_000;
    assert.equal(store.state(ref), "expired");
    assert.throws(() => store.readArtifact(ref), PlaytestArtifactExpiredError);
  } finally {
    cleanup();
  }
});

test("cleanup removes expired references, blobs, and windows while preserving active ones", () => {
  const { root, cleanup } = createTempDir("artifact-store-cleanup-");
  try {
    let now = 100_000;
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "test/retention",
      retentionMs: 10_000,
      now: () => now
    });

    // Write item 1 at t=100,000 (expires at t=110,000)
    const ref1 = store.writeArtifact({
      artifactId: "item-1",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("item-1-data")
    }).reference;

    const windowRef1 = store.writeWindow({
      artifactId: "window-1",
      entries: [{ line: "w1" }]
    }).reference;

    // Advance time to t=105,000 and write item 2 (expires at t=115,000)
    now = 105_000;
    const ref2 = store.writeArtifact({
      artifactId: "item-2",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("item-2-data")
    }).reference;

    // Advance time to t=112,000 (item-1 and window-1 are expired, item-2 is active)
    now = 112_000;
    assert.equal(store.state(ref1), "expired");
    assert.equal(store.state(windowRef1), "expired");
    assert.equal(store.state(ref2), "present");

    const cleanupResult = store.cleanup(now);
    assert.equal(cleanupResult.removedRefs, 2);
    assert.equal(cleanupResult.removedBlobs, 1);
    assert.equal(cleanupResult.removedWindows, 1);
    assert.deepEqual(cleanupResult.expiredRefs.slice().sort(), [
      "item-1",
      "window-1"
    ]);

    // After cleanup, expired items are not-authorized (metadata deleted)
    assert.equal(store.state(ref1), "not-authorized");
    assert.equal(store.state(windowRef1), "not-authorized");

    // Item 2 remains present and readable
    assert.equal(store.state(ref2), "present");
    assert.deepEqual(
      store.readArtifact(ref2).bytes,
      new TextEncoder().encode("item-2-data")
    );
  } finally {
    cleanup();
  }
});
