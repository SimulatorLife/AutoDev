import { ConfigError } from "./config-files.ts";

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
