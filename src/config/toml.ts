import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { parse, stringify } from "smol-toml";

export type TomlValue =
  string | number | boolean | Date | TomlValue[] | { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

export class ConfigError extends Error {}

const TRAILING_NEWLINES = /\n*$/;

export function parseTomlFile(
  filePath: string,
  label: string,
  required = true
): TomlTable {
  if (!existsSync(filePath)) {
    if (!required) return {};
    throw new ConfigError(`${label} not found: ${filePath}`);
  }
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new ConfigError(`unable to read ${label} ${filePath}: ${error}`);
  }
  try {
    const value = parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("must be a TOML table");
    return value as TomlTable;
  } catch (error) {
    throw new ConfigError(`malformed ${label} ${filePath}: ${error}`);
  }
}

export function serializeToml(value: TomlTable): string {
  return stringify(value).replace(TRAILING_NEWLINES, "\n");
}

export function atomicWrite(
  filePath: string,
  content: string,
  mode = 0o644
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath) && lstatSync(filePath).isDirectory())
    throw new ConfigError(`refusing to overwrite directory ${filePath}`);
  const directory = path.dirname(filePath);
  const temporary = mkdtempSync(
    path.join(directory, `.${filePath.split("/").pop() ?? "config"}.`)
  );
  const temporaryPath = path.join(temporary, "output");
  try {
    writeFileSync(temporaryPath, content, { mode });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function readJsonFile(
  filePath: string,
  label: string
): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("must be a JSON object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`unable to read ${label} ${filePath}: ${error}`);
  }
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function parseArgs(argv: string[]): {
  values: Record<string, string>;
  flags: Set<string>;
} {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--"))
      throw new ConfigError(`unexpected argument: ${arg ?? ""}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      i += 1;
    } else flags.add(key);
  }
  return { values, flags };
}

export function requiredArg(
  values: Record<string, string>,
  name: string
): string {
  const value = values[name];
  if (!value) throw new ConfigError(`missing required argument --${name}`);
  return value;
}
