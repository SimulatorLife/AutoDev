/**
 * The standalone path-literal guard for a locally checked-out OpenLIT client.
 *
 * The scanner itself lives in `openlit-path-literal-scan.ts` so that
 * `openlit-patches-apply.test.ts` can run it against the tree it just applied,
 * without needing this environment variable.
 *
 * Set `OPENLIT_CLIENT_DIR` to the client root (the directory holding `src/app`)
 * to enable these two assertions; they skip otherwise.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  deadPathLiterals,
  hasClientTree,
  pagesOutsideMiddleware
} from "./openlit-path-literal-scan.ts";

const CLIENT = process.env.OPENLIT_CLIENT_DIR ?? "";
const available = hasClientTree(CLIENT);
const skip = available
  ? false
  : "no OpenLIT client tree (set OPENLIT_CLIENT_DIR)";

test(
  "every absolute path literal in the OpenLIT client resolves",
  { skip },
  () => {
    const dead = deadPathLiterals(CLIENT);
    assert.deepEqual(
      dead,
      [],
      `these path literals resolve to no OpenLIT route:\n${dead.join("\n")}`
    );
  }
);

test("every OpenLIT page runs through the middleware matcher", { skip }, () => {
  const uncovered = pagesOutsideMiddleware(CLIENT);
  assert.deepEqual(
    uncovered,
    [],
    `these pages are not in src/middleware.ts config.matcher:\n${uncovered.join("\n")}`
  );
});
