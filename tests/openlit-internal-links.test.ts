import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * Every internal navigation target in the patched OpenLIT client must resolve
 * to a route the app actually serves.
 *
 * Four dead links got through review before this file existed, and each was a
 * different shape:
 *
 *   /settings/database-config  a redirect to `/organisation`, deleted in patch 32
 *   /rule-engine/<id>          linked from the evaluation panel, deleted in patch 30
 *   /manage-models             an alias nothing linked to
 *   /agents                    a sidebar entry left behind when patch 37 deleted
 *                              the agents page
 *
 * All four were reachable by clicking. None of them is unusual — each is what
 * you get when a page is deleted and the reference is not — so reading for them
 * individually does not scale. This derives the served route set from the App
 * Router's own `page.tsx`/`route.ts` files and diffs it against every internal
 * target in the source, which makes the next one a test failure instead of a
 * bug report.
 *
 * It runs against the applied patch chain when one is available and skips
 * rather than failing when the OpenLIT tree has not been materialised, because
 * "the fork is not checked out here" is not a product defect. Set
 * OPENLIT_CLIENT_DIR to point at a tree.
 */
const CLIENT = process.env.OPENLIT_CLIENT_DIR ?? "";
const APP = CLIENT ? join(CLIENT, "src/app") : "";
const SRC = CLIENT ? join(CLIENT, "src") : "";
const available = CLIENT && statSafe(APP) && statSafe(SRC);

function statSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Route groups `(playground)` do not appear in a URL. */
function toRoute(file: string): string {
  return (
    "/" +
    relative(APP, file)
      .replace(/\/(page|route)\.tsx?$/, "")
      .split("/")
      .filter((seg) => seg && !(seg.startsWith("(") && seg.endsWith(")")))
      .join("/")
      .replace(/\/$/, "")
  );
}

const normalise = (r: string) => (r === "/" ? "/" : r.replace(/\/$/, ""));

/**
 * Does `target` resolve to a route?
 *
 * An interpolated suffix names a fixed prefix plus a value only known at
 * runtime: `/api/telemetry/request/span/${id}/heirarchy${qs}` is really
 * "under /api/telemetry/request/span". Truncating at the first `${` and
 * wildcard-matching the remainder is what keeps those from reading as broken
 * — matching the interpolated segment against `[id]` instead is what produced
 * a false positive on every one of them.
 */
function matches(target: string, routes: Set<string>): boolean {
  const base = normalise(
    target.split("?")[0]!.split("#")[0]!.split("${")[0]!.replace(/\/$/, "")
  );
  if (routes.has(base)) return true;
  const segs = base.split("/").filter(Boolean);
  for (const route of routes) {
    const routeSegs = normalise(route).split("/").filter(Boolean);
    // `[...segments]` absorbs any number of trailing segments.
    const catchAll = routeSegs.findIndex((s) => s.startsWith("[..."));
    if (catchAll >= 0) {
      if (segs.length >= catchAll) return true;
      continue;
    }
    if (routeSegs.length !== segs.length) {
      // `/evaluations/evaluators/${id}` and `/telemetry/traces/${spanId}` name a
      // literal parent whose only children are parameters. That resolves.
      const parentOfDynamicChildren =
        segs.length < routeSegs.length &&
        segs.every((seg, i) => routeSegs[i] === seg) &&
        routeSegs.slice(segs.length).every((s) => s.startsWith("["));
      if (parentOfDynamicChildren) return true;
      continue;
    }
    if (routeSegs.every((seg, i) => seg.startsWith("[") || seg === segs[i]))
      return true;
  }
  return false;
}

const TARGET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "href", re: /href=\{?["'`]([^"'`]+)["'`]\}?/g },
  { name: "router.push", re: /router\.push\(\s*["'`]([^"'`]+)["'`]/g },
  { name: "router.replace", re: /router\.replace\(\s*["'`]([^"'`]+)["'`]/g },
  { name: "window.open", re: /window\.open\(\s*["'`]([^"'`]+)["'`]/g },
  { name: "fetch url", re: /url:\s*["'`]([^"'`]+)["'`]/g },
  // Navigation tables build items as `{ link: "/x" }`, so an href-only scan
  // cannot see where primary navigation goes. That is where the /agents
  // entry lived.
  { name: "link entry", re: /\blink:\s*["'`](\/[^"'`]*)["'`]/g },
  { name: "redirect()", re: /\bredirect\(\s*["'`](\/[^"'`]*)["`]/g },
  {
    name: "routerRef.replace",
    re: /routerRef\.current\.replace\(\s*["'`](\/[^"'`]*)["`]/g
  }
];

test(
  "every internal navigation target in the OpenLIT client resolves to a served route",
  {
    skip: available ? false : "no OpenLIT client tree (set OPENLIT_CLIENT_DIR)"
  },
  () => {
    const pages = new Set<string>();
    const api = new Set<string>();
    for (const file of walk(APP)) {
      const rel = relative(APP, file);
      if (/(^|\/)page\.tsx?$/.test(rel)) pages.add(normalise(toRoute(file)));
      else if (/(^|\/)route\.tsx?$/.test(rel))
        api.add(normalise(toRoute(file)));
    }

    const dead: string[] = [];
    for (const file of walk(SRC)) {
      if (!/\.tsx?$/.test(file) || file.includes("/__tests__/")) continue;
      const body = readFileSync(file, "utf8");
      for (const { name, re } of TARGET_PATTERNS) {
        re.lastIndex = 0;
        for (const m of body.matchAll(re)) {
          const target = m[1]!;
          if (!target.startsWith("/")) continue;
          if (/^\/(_next|images|static)\b/.test(target)) continue;
          const ok = target.startsWith("/api/")
            ? matches(target, api)
            : matches(target, pages);
          if (!ok) dead.push(`${relative(SRC, file)} (${name}) -> ${target}`);
        }
      }
    }

    assert.deepEqual(
      dead,
      [],
      `these internal targets have no matching route, so each one is a link to a 404:\n${dead.join("\n")}`
    );
  }
);
