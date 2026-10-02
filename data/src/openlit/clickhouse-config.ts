import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DATABASE_PASSWORD_LINE = /^OPENLIT_DB_PASSWORD=(.*)$/mu;

export interface OpenLitClickHouseOptions {
  readonly codexHome?: string;
  readonly clickhouseUrl?: string;
  readonly dbUser?: string;
  readonly dbPassword?: string;
  readonly dbName?: string;
}

export interface OpenLitClickHouseConnection {
  readonly clickhouseUrl: string;
  readonly endpoint: string;
}

function readDatabasePassword(codexHome: string): string {
  const secretFile = path.join(codexHome, "openlit-secrets.env");
  if (!existsSync(secretFile)) return "";
  const match = readFileSync(secretFile, "utf8").match(DATABASE_PASSWORD_LINE);
  return match?.[1]?.trim() ?? "";
}

/** Resolve ClickHouse credentials once for every Data-owned OpenLIT projection adapter. */
export function resolveOpenLitClickHouseConnection(
  options: OpenLitClickHouseOptions = {},
  environment: NodeJS.ProcessEnv = process.env
): OpenLitClickHouseConnection {
  const codexHome =
    options.codexHome?.trim() ||
    environment.CODEX_HOME ||
    path.join(environment.HOME || homedir(), ".codex");
  const clickhouseUrl =
    options.clickhouseUrl ||
    environment.CLICKHOUSE_URL ||
    "http://127.0.0.1:8123";
  const dbUser = options.dbUser || environment.OPENLIT_DB_USER || "default";
  const dbPassword =
    options.dbPassword ||
    environment.OPENLIT_DB_PASSWORD ||
    readDatabasePassword(codexHome);
  const dbName = options.dbName || environment.OPENLIT_DB_NAME || "openlit";
  const endpoint = `${clickhouseUrl}/?user=${encodeURIComponent(
    dbUser
  )}&password=${encodeURIComponent(dbPassword)}&database=${encodeURIComponent(
    dbName
  )}`;
  return { clickhouseUrl, endpoint };
}
