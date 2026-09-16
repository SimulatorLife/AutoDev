import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync, lstatSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "smol-toml";

export type TomlValue = string | number | boolean | Date | TomlValue[] | { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

export class ConfigError extends Error {}

export function parseTomlFile(path: string, label: string, required = true): TomlTable {
  if (!existsSync(path)) {
    if (!required) return {};
    throw new ConfigError(`${label} not found: ${path}`);
  }
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { throw new ConfigError(`unable to read ${label} ${path}: ${error}`); }
  try {
    const value = parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be a TOML table");
    return value as TomlTable;
  } catch (error) {
    throw new ConfigError(`malformed ${label} ${path}: ${error}`);
  }
}

export function serializeToml(value: TomlTable): string {
  return stringify(value).replace(/\n*$/, "\n");
}

export function atomicWrite(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isDirectory()) throw new ConfigError(`refusing to overwrite directory ${path}`);
  const directory = dirname(path);
  const temporary = mkdtempSync(join(directory, `.${path.split("/").pop() ?? "config"}.`));
  const temporaryPath = join(temporary, "output");
  try {
    writeFileSync(temporaryPath, content, { mode });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function readJsonFile(path: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be a JSON object");
    return value as Record<string, unknown>;
  } catch (error) { throw new ConfigError(`unable to read ${label} ${path}: ${error}`); }
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function parseArgs(argv: string[]): { values: Record<string, string>; flags: Set<string> } {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) throw new ConfigError(`unexpected argument: ${arg ?? ""}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { values[key] = next; i += 1; }
    else flags.add(key);
  }
  return { values, flags };
}

export function requiredArg(values: Record<string, string>, name: string): string {
  const value = values[name];
  if (!value) throw new ConfigError(`missing required argument --${name}`);
  return value;
}
