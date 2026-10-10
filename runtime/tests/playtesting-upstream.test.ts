import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const vendorRoot = join(import.meta.dirname, "../vendor/jev-playtest-lab");
const PINNED_FILES = [
  [
    "src/core.js",
    "df42538a90cae190a0d91ab67f64355204af231a979447c21212446ee29222ad"
  ],
  [
    "test/core.test.js",
    "6ca6ee1a4d18e03a5711fdcd3cd3735dbc59f4a28779eeae15b229af43bcfd34"
  ],
  [
    "LICENSE",
    "68125087b24b8d1ce46218ee20b127bb70f922107c7171b74ca2cc99df0c2494"
  ]
] as const;

test("Jev Playtest Lab files remain intact at the audited MIT commit", () => {
  for (const [relativePath, expectedDigest] of PINNED_FILES) {
    const content = readFileSync(join(vendorRoot, relativePath));
    const digest = createHash("sha256").update(content).digest("hex");
    assert.equal(
      digest,
      expectedDigest,
      `${relativePath} changed; re-audit upstream`
    );
  }
});
