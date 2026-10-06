/**
 * Path-literal scanner for the OpenLIT client.
 *
 * `openlit-internal-links.test.ts` only inspects an `href`/`redirect` *shape*,
 * which is not the same as seeing every link: `href={cond ? "/a" : `/b/${id}`}`
 * has no literal href, so a shape-based scan inspects nothing. The tenancy
 * residue this guards — `/organisation/project/${projectId}/connectors`, left
 * behind by the tenancy removal — was exactly that shape, and it survived every
 * review. So every absolute path literal in the client has to resolve as well.
 *
 * This is a module rather than part of the test so that two callers can run it:
 * the standalone guard, and `openlit-patches-apply.test.ts`, which has an
 * applied tree on disk and would otherwise need a guard that only runs when
 * somebody remembers to set an environment variable.
 *
 * Every exclusion below is a measured one, i.e. it was added because it fired
 * on a literal that is genuinely not a route, and each one is scoped as tightly
 * as the finding allowed:
 *   - `matchesApi` wildcard: `/api/evaluation/llm/Hallucination` against
 *     `/api/evaluation/llm/[evalType]`
 *   - the API prefix rule: `pathname.startsWith("/api")` in check-auth
 *   - middleware matchers are *not* excluded — `"/settings/:path*"` is reduced
 *     to `/settings` and matched as a page prefix, which is what makes a stale
 *     `"/exceptions"` entry a finding rather than a suppressed one
 *   - the document-extension rule: `/openlit/${slug(content)}.md` in the Claude
 *     memory adapter
 *   - `utils/validation.ts`, which matches macOS/Linux path roots inside error
 *     message text
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True when `client` looks like an OpenLIT client checkout. */
export function hasClientTree(client: string): boolean {
  return (
    !!client && isDir(join(client, "src/app")) && isDir(join(client, "src"))
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const normalise = (r: string) => (r === "/" ? "/" : r.replace(/\/$/u, ""));

function toRoute(app: string, file: string): string {
  const stripped = relative(app, file).replace(/\/(page|route)\.tsx?$/u, "");
  const withoutFile =
    stripped === "page.tsx" || stripped === "route.ts" ? "" : stripped;
  return (
    "/" +
    withoutFile
      .split("/")
      .filter((seg) => seg && !(seg.startsWith("(") && seg.endsWith(")")))
      .join("/")
      .replace(/\/$/u, "")
  );
}

export function readRouteSets(client: string): {
  pages: Set<string>;
  api: Set<string>;
} {
  const app = join(client, "src/app");
  const pages = new Set<string>();
  const api = new Set<string>();
  for (const file of walk(app)) {
    const rel = relative(app, file);
    if (/(^|\/)page\.tsx?$/u.test(rel))
      pages.add(normalise(toRoute(app, file)));
    else if (/(^|\/)route\.tsx?$/u.test(rel))
      api.add(normalise(toRoute(app, file)));
  }
  return { pages, api };
}

/** `/settings/:path*` matches `/settings` and every page below it. */
function stripMatcher(token: string): string {
  return token.replace(/\/:\w+\*$/u, "");
}

/**
 * An interpolated suffix names a fixed prefix plus a value only known at
 * runtime, so the target is truncated at the first `${` and wildcard-matched.
 */
function matches(target: string, routes: Set<string>): boolean {
  const base = normalise(
    target.split("?")[0]!.split("#")[0]!.split("${")[0]!.replace(/\/$/u, "")
  );
  if (routes.has(base)) return true;
  const segs = base.split("/").filter(Boolean);
  for (const route of routes) {
    const routeSegs = normalise(route).split("/").filter(Boolean);
    const catchAll = routeSegs.findIndex((s) => s.startsWith("[..."));
    if (catchAll >= 0) {
      if (
        segs.length >= catchAll &&
        segs.slice(0, catchAll).every((s, i) => routeSegs[i] === s)
      ) {
        return true;
      }
      continue;
    }
    if (routeSegs.length !== segs.length) {
      if (
        segs.length < routeSegs.length &&
        segs.every((seg, i) => routeSegs[i] === seg) &&
        routeSegs.slice(segs.length).every((s) => s.startsWith("["))
      ) {
        return true;
      }
      continue;
    }
    if (routeSegs.every((seg, i) => seg.startsWith("[") || seg === segs[i])) {
      return true;
    }
  }
  return false;
}

/** A middleware matcher is a prefix assertion, so a shorter route resolves it. */
function matchesAsMatcherPrefix(target: string, routes: Set<string>): boolean {
  const base = normalise(stripMatcher(target));
  if (routes.has(base)) return true;
  const baseSegs = base.split("/").filter(Boolean);
  for (const route of routes) {
    const routeSegs = normalise(route).split("/").filter(Boolean);
    if (baseSegs.every((seg, i) => routeSegs[i] === seg)) return true;
  }
  return false;
}

/**
 * API paths are routinely built by appending parameters to a prefix, so a
 * segment-wise prefix against `[param]` routes is the correct test rather than
 * the wildcard rule. `pathname.startsWith("/api")` is an idiom here, hence the
 * `baseSegs` prefix case — scoped to API targets, because a *page* literal
 * that is only a prefix of another page (e.g. `/agents`) is a dead link.
 */
function matchesApi(target: string, routes: Set<string>): boolean {
  const base = normalise(
    target.split("?")[0]!.split("${")[0]!.replace(/\/$/u, "")
  );
  if (routes.has(base)) return true;
  const segs = base.split("/").filter(Boolean);
  for (const route of routes) {
    const routeSegs = normalise(route).split("/").filter(Boolean);
    const catchAll = routeSegs.findIndex((s) => s.startsWith("[..."));
    if (catchAll >= 0) {
      if (
        segs.length >= catchAll &&
        segs.slice(0, catchAll).every((s, i) => routeSegs[i] === s)
      ) {
        return true;
      }
      continue;
    }
    if (
      routeSegs.length >= segs.length &&
      segs.every((s, i) => routeSegs[i]?.startsWith("[") || routeSegs[i] === s)
    ) {
      return true;
    }
    if (segs.every((s, i) => routeSegs[i] === s)) return true;
  }
  return false;
}

const PATH_LITERAL = /["'`](\/[A-Za-z0-9][^"'`\s]*)/gu;
const NOT_A_PATH: readonly RegExp[] = [
  /^\/[a-z]+,$/u, // a regex replacement flag such as "/g,"
  /^\/(use-assessments|session-outcome)\??$/u, // fragments joined onto a base
  /\.(md|json|ya?ml|txt|csv)$/u // a document inside a repository, not a route
];
const FILE_NOT_ABOUT_ROUTES: Record<string, string> = {
  // Matches macOS/Linux filesystem path roots inside error-message text.
  "utils/validation.ts": "filesystem path prefixes"
};

const stripComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1");

/** Every path literal under `client/src` that resolves to no route. */
export function deadPathLiterals(client: string): string[] {
  const src = join(client, "src");
  const { pages, api } = readRouteSets(client);
  const dead: string[] = [];
  for (const file of walk(src)) {
    if (!/\.tsx?$/u.test(file) || file.includes("__tests__")) continue;
    const rel = relative(src, file);
    if (rel in FILE_NOT_ABOUT_ROUTES) continue;
    const body = stripComments(readFileSync(file, "utf8"));
    PATH_LITERAL.lastIndex = 0;
    for (const m of body.matchAll(PATH_LITERAL)) {
      const target = m[1]!;
      if (/^\/(_next|images|static|favicon)/u.test(target)) continue;
      if (NOT_A_PATH.some((re) => re.test(target))) continue;
      const matcher = /:\w+\*$/u.test(target);
      const stripped = matcher ? stripMatcher(target) : target;
      const isApi = stripped === "/api" || stripped.startsWith("/api/");
      const ok = isApi
        ? matchesApi(stripped, api)
        : matcher
          ? matchesAsMatcherPrefix(stripped, pages)
          : matches(target, pages);
      if (!ok) dead.push(`${rel} -> ${target}`);
    }
  }
  return dead;
}

/**
 * The middleware chain (CSRF, auth, demo-account) only runs on
 * `config.matcher`, so a page outside it is silently ungated. `/` is the one
 * exception: it is a redirect with no request of its own.
 */
export function pagesOutsideMiddleware(client: string): string[] {
  const { pages } = readRouteSets(client);
  const middleware = readFileSync(join(client, "src/middleware.ts"), "utf8");
  const at = middleware.indexOf("matcher:");
  const matcher = middleware.slice(at, middleware.indexOf("];", at));
  const patterns: string[] = [];
  PATH_LITERAL.lastIndex = 0;
  for (const m of stripComments(matcher).matchAll(PATH_LITERAL)) {
    if (!m[1]!.startsWith("/api")) patterns.push(m[1]!);
  }
  if (patterns.length === 0)
    throw new Error("no page patterns parsed from config.matcher");
  return [...pages]
    .filter((page) => page !== "/")
    .filter(
      (page) =>
        !patterns.some((p) => matchesAsMatcherPrefix(p, new Set([page])))
    )
    .sort();
}
