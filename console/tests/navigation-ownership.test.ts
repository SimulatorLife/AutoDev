import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The modules that own the Console's navigation.
 *
 * The whole-page owner asks for the destination's page and navigates once that
 * answer is in hand, because a navigation that has to answer for itself never
 * commits -- the address bar stays where it was and the page does not move.
 * The form owner is the boundary between that owner and Next.js's router, and
 * the link asks the owner on the operator's click. Everything else in the
 * Console reaches its destinations through `NavigationLink`, which asks the
 * owner.
 */
const NAVIGATION_OWNERS = new Set([
  "src/components/navigation/whole-page-navigation.ts",
  "src/components/navigation/FormNavigationOwner.ts",
  "src/components/navigation/NavigationLink.ts"
]);

/**
 * The paths another session owns.
 *
 * The Playtesting workspace is being migrated to the same owner by another
 * session. The exclusion is written down rather than hidden, so that the
 * guard's claim stays exact about what it covers and what it does not.
 */
const OTHER_SESSION_PATHS = ["src/features/playtesting/", "app/playtesting/"];

/** The source roots the Console's own code lives in. */
const SOURCE_ROOTS = ["src", "app"];

function consoleSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...consoleSources(path));
      continue;
    }
    const extension = extname(entry.name);
    if (extension === ".ts" || extension === ".tsx") {
      found.push(path);
    }
  }
  return found;
}

test("only the navigation owner drives the router", () => {
  // A feature that drives the router itself brings the strand back with it,
  // and it brings it back silently: the reducer applies the destination, React
  // renders it, and the commit that moves the address bar never runs. The
  // browser acceptance measured that a navigation whose answer was already in
  // hand committed every time and one that had to answer for itself did not
  // commit at all, so the owner is the only place a Console navigation may
  // start.
  const consoleRoot = fileURLToPath(new URL("../", import.meta.url));
  const offenders: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const path of consoleSources(join(consoleRoot, root))) {
      const relativePath = relative(consoleRoot, path).split("\\").join("/");
      if (
        OTHER_SESSION_PATHS.some((excluded) =>
          relativePath.startsWith(excluded)
        )
      ) {
        continue;
      }
      const source = readFileSync(path, "utf8");
      const drivesRouter =
        /useRouter\(\)|router\.(?:push|replace|refresh|prefetch)\(/u.test(
          source
        );
      if (!drivesRouter) continue;
      if (NAVIGATION_OWNERS.has(relativePath)) continue;
      offenders.push(relativePath);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "only the whole-page owner may drive the router; these modules drive it " +
      "themselves, and a navigation that has to answer for itself never commits"
  );
});
