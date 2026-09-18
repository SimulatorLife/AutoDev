import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, symlinkSync, mkdirSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { ConfigError, parseArgs, readJsonFile, requiredArg } from "./toml.ts";

const ROOTS: Record<string, string> = { claude: join(".claude", "skills") };

function removeManaged(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      rmSync(path, { recursive: true, force: true });
    } else {
      unlinkSync(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function lstatSafe(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }

export function expectedSkillViews(contract: Record<string, unknown>, canonicalRoot: string, outputRoot: string, provider: string): Map<string, string> {
  const relativeRoot = ROOTS[provider];
  if (!relativeRoot) throw new ConfigError(`unsupported provider skill layout: ${provider}`);
  const roles = contract.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) throw new ConfigError("execution contract roles must be an object");
  const expected = new Map<string, string>();
  for (const [role, raw] of Object.entries(roles)) {
    const skills = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).skills : undefined;
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      if (typeof skill !== "string") continue;
      const source = join(canonicalRoot, skill);
      if (!existsSync(join(source, "SKILL.md"))) throw new ConfigError(`role ${role} declares missing skill source: ${skill} (${source})`);
      expected.set(join(outputRoot, role, relativeRoot, skill), source);
    }
  }
  return expected;
}

export function renderProviderSkillViews(contractPath: string, canonicalRoot: string, outputRoot: string, provider = "claude", check = false): void {
  const contract = readJsonFile(contractPath, "execution contract");
  const expected = expectedSkillViews(contract, canonicalRoot, outputRoot, provider);
  const rolesValue = contract.roles;
  const roles = new Set(rolesValue && typeof rolesValue === "object" && !Array.isArray(rolesValue) ? Object.keys(rolesValue) : []);
  if (check) {
    if (!existsSync(outputRoot)) throw new ConfigError(`missing provider skill view root: ${outputRoot}`);
    const actual = new Set<string>();
    for (const role of readdirSync(outputRoot)) {
      const root = join(outputRoot, role, ROOTS[provider]!);
      if (!existsSync(root)) continue;
      for (const skill of readdirSync(root)) { const target = join(root, skill); if (lstatSafe(target) && lstatSync(target).isSymbolicLink()) actual.add(target); }
    }
    const missing = [...expected.keys()].filter((path) => !actual.has(path)), stale = [...actual].filter((path) => !expected.has(path));
    if (missing.length || stale.length) throw new ConfigError(`provider skill view drift; missing=${JSON.stringify(missing)}, stale=${JSON.stringify(stale)}`);
    for (const [target, source] of expected) if (readlinkSync(target) !== source) throw new ConfigError(`provider skill view drift: ${target} -> ${readlinkSync(target)} (expected ${source})`);
    const actualRoles = new Set(readdirSync(outputRoot).filter((name) => lstatSafe(join(outputRoot, name)) && lstatSync(join(outputRoot, name)).isDirectory()));
    if (actualRoles.size !== roles.size || [...actualRoles].some((role) => !roles.has(role))) throw new ConfigError("provider skill role view drift");
    return;
  }
  mkdirSync(outputRoot, { recursive: true });
  for (const role of roles) mkdirSync(join(outputRoot, role, ROOTS[provider]!), { recursive: true });
  for (const role of readdirSync(outputRoot)) if (!roles.has(role)) removeManaged(join(outputRoot, role));
  for (const role of roles) {
    const root = join(outputRoot, role, ROOTS[provider]!);
    for (const name of readdirSync(root)) if (![...expected.keys()].some((path) => path === join(root, name))) removeManaged(join(root, name));
  }
  for (const [target, source] of expected) {
    mkdirSync(dirnameOfLink(target), { recursive: true });
    if (lstatSafe(target) && lstatSync(target).isSymbolicLink() && readlinkSync(target) === source) continue;
    removeManaged(target);
    try {
      symlinkSync(source, target, "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (lstatSafe(target) && lstatSync(target).isSymbolicLink() && readlinkSync(target) === source) continue;
        removeManaged(target);
        symlinkSync(source, target, "dir");
      } else {
        throw error;
      }
    }
  }
}
function dirnameOfLink(path: string): string { return path.slice(0, path.lastIndexOf("/")); }

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try { const { values, flags } = parseArgs(process.argv.slice(2)); renderProviderSkillViews(requiredArg(values, "contract"), requiredArg(values, "canonical-root"), requiredArg(values, "output-root"), values.provider ?? "claude", flags.has("check")); console.log(`${flags.has("check") ? "checked" : "rendered"} ${values.provider ?? "claude"} skill views in ${requiredArg(values, "output-root")}`); }
  catch (error) { console.error(`render-provider-skill-views: ${error instanceof Error ? error.message : error}`); process.exitCode = 2; }
}
