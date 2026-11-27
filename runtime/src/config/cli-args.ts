import { ConfigError } from "./config-files.ts";

export function parseArgs(argv: string[]): {
  values: Record<string, string>;
  flags: Set<string>;
} {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--"))
      throw new ConfigError(`unexpected argument: ${argument ?? ""}`);
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      index += 1;
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
