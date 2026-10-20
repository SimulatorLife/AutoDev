import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";

const CONSOLE_ROOT = join(import.meta.dirname, "..");
const APP_ROOT = join(CONSOLE_ROOT, "app");
const SOURCE_ROOT = join(CONSOLE_ROOT, "src");
const BREADCRUMBS_COMPONENT = join(
  CONSOLE_ROOT,
  "src/components/navigation/Breadcrumbs.ts"
);
const ACCEPTANCE_SPEC = join(
  CONSOLE_ROOT,
  "e2e/breadcrumbs-acceptance.spec.ts"
);

/**
 * The routes the playtesting session owns.
 *
 * The playtesting session detail is the one detail surface that presents no
 * trail, and it is another session's work, so it is named here rather than
 * quietly skipped: a guard that skipped every route it did not like would
 * skip this one too, and for the wrong reason.
 */
const PLAYTESTING_ROUTE_PREFIX = "/playtesting";

function filesUnder(root: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...filesUnder(path));
    } else {
      found.push(path);
    }
  }
  return found;
}

/** One route of the Console, as its path segments. */
interface Route {
  /** The route's segments, with the dynamic ones as `[name]`. */
  readonly segments: readonly string[];
  /** The page file that serves it. */
  readonly page: string;
}

function routes(): readonly Route[] {
  return filesUnder(APP_ROOT)
    .filter((path) => path.endsWith(`${sep}page.tsx`))
    .map((page) => ({
      segments: relative(APP_ROOT, page).split(sep).slice(0, -1),
      page
    }));
}

/** The routes that address one resource rather than a collection. */
function detailRoutes(): readonly Route[] {
  return routes().filter((route) =>
    route.segments.some((segment) => segment.startsWith("["))
  );
}

function routePath(route: Route): string {
  return `/${route.segments.join("/")}`;
}

/**
 * The feature modules a route's page renders.
 *
 * The page is the route's own file, so the modules it imports from
 * `src/features` are the views that decide what the route presents.
 */
function featureModules(route: Route): readonly string[] {
  const source = readFileSync(route.page, "utf8");
  const pattern = /from\s+"((?:\.\.\/)+src\/features\/[^"]+)"/gu;
  const modules: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    modules.push(join(dirname(route.page), specifier));
  }
  return modules;
}

test("every detail route presents the shared breadcrumb landmark", () => {
  const detail = detailRoutes().filter(
    (route) => !routePath(route).startsWith(PLAYTESTING_ROUTE_PREFIX)
  );
  assert.ok(detail.length > 0, "the Console has detail routes to check");

  for (const route of detail) {
    const modules = featureModules(route);
    const renders = modules.some((module) =>
      readFileSync(module, "utf8").includes("React.createElement(Breadcrumbs")
    );
    assert.ok(
      renders,
      `${routePath(route)} renders no trail: neither ${modules.join(" nor ")} presents the shared Breadcrumbs`
    );
  }
});

test("the breadcrumb landmark has one owner", () => {
  // A second place that renders the landmark is a second trail with its own
  // markup, and the trails would stop agreeing about what a trail is.
  const owners = filesUnder(SOURCE_ROOT).filter((path) => {
    if (path === BREADCRUMBS_COMPONENT) return false;
    try {
      return readFileSync(path, "utf8").includes('aria-label="Breadcrumb"');
    } catch {
      return false;
    }
  });
  assert.deepEqual(owners, []);
});

test("the browser acceptance drives every detail route", () => {
  // A route can render a trail and still be a surface no browser has seen.
  // The acceptance names each route by the static part of its path, so a
  // detail route that is added without being driven fails here.
  const spec = readFileSync(ACCEPTANCE_SPEC, "utf8");
  for (const route of detailRoutes()) {
    if (routePath(route).startsWith(PLAYTESTING_ROUTE_PREFIX)) continue;
    for (const segment of route.segments.filter(
      (part) => !part.startsWith("[")
    )) {
      assert.ok(
        spec.includes(`/${segment}/`),
        `the browser acceptance does not drive ${routePath(route)}`
      );
    }
  }
});
