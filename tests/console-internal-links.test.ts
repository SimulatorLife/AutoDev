import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * Every internal navigation target in the Console must resolve to a route the
 * app actually serves.
 *
 * The OpenLIT fork had four links to deleted routes reach the product before
 * this class was automated (`/settings/database-config`, `/rule-engine/<id>`,
 * `/manage-models`, `/agents`) — each of them a page removed with a reference
 * left behind. `tests/openlit-internal-links.test.ts` covers the fork; this is
 * the same check for the Console's own thirteen routes, its navigation table
 * and its server-side redirects.
 *
 * Written against the Console itself rather than a materialised tree, so it
 * runs in `test:console` with no setup.
 */
const ROOT = join(import.meta.dirname, "..", "console");
const APP = join(ROOT, "app");

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const available = isDir(APP) && isDir(join(ROOT, "src"));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const normalise = (r: string) => (r === "/" ? "/" : r.replace(/\/$/, ""));

/**
 * Comments are stripped first because a JSDoc block describing a link contains
 * one verbatim, and `AppNav.ts` documents `<a href="/section">` in prose. A
 * guard that reports its own documentation is a guard people turn off. `//` is
 * only treated as a comment when it is not preceded by `:` so that a URL in a
 * string literal does not truncate the line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function toRoute(file: string): string {
  const stripped = relative(APP, file).replace(/\/(page|route)\.tsx?$/, "");
  // `app/page.tsx` has no directory, so the regex above leaves `page.tsx`
  // behind. The root route is `/`.
  const withoutFile =
    stripped === "page.tsx" || stripped === "route.ts" ? "" : stripped;
  return (
    "/" +
    withoutFile
      .split("/")
      .filter((seg) => seg && !(seg.startsWith("(") && seg.endsWith(")")))
      .join("/")
      .replace(/\/$/, "")
  );
}

/**
 * An interpolated suffix names a fixed prefix plus a value only known at
 * runtime, so the target is truncated at the first `${` and wildcard-matched.
 */
function matches(target: string, routes: Set<string>): boolean {
  const base = normalise(
    target.split("?")[0]!.split("#")[0]!.split("${")[0]!.replace(/\/$/, "")
  );
  if (routes.has(base)) return true;
  const segs = base.split("/").filter(Boolean);
  for (const route of routes) {
    const routeSegs = normalise(route).split("/").filter(Boolean);
    const catchAll = routeSegs.findIndex((s) => s.startsWith("[..."));
    if (catchAll >= 0) {
      if (segs.length >= catchAll) return true;
      continue;
    }
    if (routeSegs.length !== segs.length) {
      // `/providers/${id}` names a literal parent whose children are parameters.
      if (
        segs.length < routeSegs.length &&
        segs.every((seg, i) => routeSegs[i] === seg) &&
        routeSegs.slice(segs.length).every((s) => s.startsWith("["))
      ) {
        return true;
      }
      continue;
    }
    if (routeSegs.every((seg, i) => seg.startsWith("[") || seg === segs[i]))
      return true;
  }
  return false;
}

/**
 * Does an API target resolve?
 *
 * Console API paths are commonly built by appending parameters to a prefix —
 * `/api/providers/${encodeURIComponent(provider)}/roles/${role}` truncates to
 * `/api/providers`, which is a prefix of a served route rather than one. The
 * caller supplies the rest, so a segment-wise prefix is the correct test here.
 */
function matchesApi(target: string, routes: Set<string>): boolean {
  const base = normalise(
    target.split("?")[0]!.split("${")[0]!.replace(/\/$/, "")
  );
  if (routes.has(base)) return true;
  const segs = base.split("/").filter(Boolean);
  for (const route of routes) {
    const routeSegs = normalise(route).split("/").filter(Boolean);
    if (routeSegs.length < segs.length) continue;
    if (segs.every((seg, i) => routeSegs[i] === seg)) return true;
  }
  return false;
}

const TARGET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "href", re: /href=\{?["'`]([^"'`]+)["'`]\}?/g },
  { name: "router.push", re: /router\.push\(\s*["'`]([^"'`]+)["'`]/g },
  { name: "redirect()", re: /\bredirect\(\s*["'`](\/[^"'`]*)["`]/g },
  {
    name: "permanentRedirect()",
    re: /permanentRedirect\(\s*["'`](\/[^"'`]*)["`]/g
  },
  { name: "nav entry", re: /\bhref:\s*["'`](\/[^"'`]*)["'`]/g },
  {
    name: "path/to/link/url entry",
    re: /\b(?:path|to|link|url):\s*["'`](\/[^"'`]*)["'`]/g
  }
];

test(
  "every internal navigation target in the Console resolves to a served route",
  { skip: available ? false : "console tree not present" },
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
    const sources = [...walk(join(ROOT, "src")), ...walk(APP)].filter(
      (f) =>
        /\.tsx?$/.test(f) && !f.includes("/tests/") && !f.includes("__tests__")
    );
    for (const file of sources) {
      const body = stripComments(readFileSync(file, "utf8"));
      for (const { name, re } of TARGET_PATTERNS) {
        re.lastIndex = 0;
        for (const m of body.matchAll(re)) {
          const target = m[1]!;
          if (!target.startsWith("/")) continue;
          if (/^\/(_next|images|static|favicon)/.test(target)) continue;
          const ok = target.startsWith("/api/")
            ? matches(target, api)
            : matches(target, pages);
          if (!ok) dead.push(`${relative(ROOT, file)} (${name}) -> ${target}`);
        }
      }
    }

    assert.deepEqual(
      dead,
      [],
      `these Console targets have no matching route, so each one is a link to a 404:\n${dead.join("\n")}`
    );
  }
);

/**
 * A string literal that looks like an absolute path, in the code the browser
 * runs.
 *
 * The patterns above only see an `href`/`redirect` *shape*, which misses the
 * case that produced the OpenLIT `Agents` 404 and the case found while proving
 * this guard: an href computed through a variable or a ternary, where the dead
 * path is an ordinary string literal a shape-based scan never inspects.
 *
 * Scoped to `src/components`, `src/features` and `app` deliberately. Server
 * modules hold path-shaped literals that are not navigation at all — the
 * Console's `control-api.ts` calls the Runtime's `/control/*` endpoints, and
 * those must not be checked against the Console's own route table.
 */
const UI_SOURCE = /^(src\/(components|features)\/|app\/)/u;
const PATH_LITERAL = /["'`](\/[A-Za-z0-9][^"'`\s]*)/g;

test(
  "every absolute path literal in the Console's UI code resolves",
  { skip: available ? false : "console tree not present" },
  () => {
    const pages = new Set<string>();
    const api = new Set<string>();
    for (const file of walk(APP)) {
      const rel = relative(APP, file);
      if (/(^|\/)page\.tsx?$/.test(rel)) pages.add(normalise(toRoute(file)));
      else if (/(^|\/)route\.tsx?$/.test(rel))
        api.add(normalise(toRoute(file)));
    }

    const sources = [...walk(join(ROOT, "src")), ...walk(APP)]
      .filter(
        (f) =>
          /\.tsx?$/.test(f) &&
          !f.includes("/tests/") &&
          !f.includes("__tests__")
      )
      .map((f) => relative(ROOT, f))
      .filter((f) => UI_SOURCE.test(f));

    const dead: string[] = [];
    for (const rel of sources) {
      const body = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      PATH_LITERAL.lastIndex = 0;
      for (const m of body.matchAll(PATH_LITERAL)) {
        const target = m[1]!;
        if (/^\/(_next|images|static|favicon)/.test(target)) continue;
        const ok = target.startsWith("/api/")
          ? matchesApi(target, api)
          : matches(target, pages);
        if (!ok) dead.push(`${rel} -> ${target}`);
      }
    }

    assert.deepEqual(
      dead,
      [],
      `these path literals in UI code resolve to no Console route:\n${dead.join("\n")}`
    );
  }
);

const CORE_NAV = join(
  import.meta.dirname,
  "..",
  "core",
  "src",
  "navigation.ts"
);

test(
  "every canonical navigation section resolves to a Console route",
  {
    skip:
      available && existsSync(CORE_NAV)
        ? false
        : "core navigation source not present"
  },
  () => {
    // `canonicalNavPath(section)` is `/${section.toLowerCase()}`, so the sidebar
    // builds its own hrefs from the section name. A string scan cannot see a
    // link that is computed, which is exactly how a nav entry ends up pointing
    // at a page nobody wrote: the OpenLIT `Agents` entry had no literal URL at
    // all. This asserts the computed form instead.
    //
    // The sections are read out of the Core source rather than imported, so the
    // check cannot be satisfied by a stale build artefact.
    const core = readFileSync(CORE_NAV, "utf8");
    const sections = [...core.matchAll(/sections:\s*\[([^\]]*)\]/g)].flatMap(
      (m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((s) => s[1]!)
    );
    assert.ok(
      sections.length > 0,
      "the canonical navigation list must not be empty"
    );

    const pages = new Set<string>();
    for (const file of walk(APP)) {
      if (/(^|\/)page\.tsx?$/.test(relative(APP, file)))
        pages.add(normalise(toRoute(file)));
    }

    const deadSections = sections
      .map((section) => ({ section, href: `/${section.toLowerCase()}` }))
      .filter(({ href }) => !pages.has(href))
      .map(({ section, href }) => `${section} -> ${href}`);

    assert.deepEqual(
      deadSections,
      [],
      `every canonical nav section renders a sidebar link, so one without a page is a 404:\n${deadSections.join("\n")}`
    );
  }
);
