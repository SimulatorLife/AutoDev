import { existsSync, readFileSync } from "node:fs";

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

/**
 * A configuration value as TOML.
 *
 * A table is written as an inline table with quoted keys, because JSON is not
 * TOML: a header name such as `X-Goog-Api-Key` has to be quoted for the
 * rendered configuration to parse. Every other value is written as JSON,
 * which is TOML for a string, a number, a boolean and an array of them.
 */
export function tomlValue(value: TomlValue): string {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  ) {
    const entries = Object.entries(value as TomlTable).map(
      ([key, entry]) => `${JSON.stringify(key)} = ${tomlValue(entry)}`
    );
    return `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value);
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
