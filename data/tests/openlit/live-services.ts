import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveOpenLitClickHouseConnection } from "../../src/openlit/clickhouse-config.ts";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 2000;

/**
 * Sync tests that run against a live local OpenLIT deployment are skipped,
 * with a reason, when that deployment does not answer. They are never
 * reported as passing without having run, and once the service answers any
 * failure is a real failure.
 */
export async function clickHouseSkipReason(): Promise<string | false> {
  const { clickhouseUrl } = resolveOpenLitClickHouseConnection();
  try {
    const response = await fetch(`${clickhouseUrl}/ping`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    return response.ok
      ? false
      : `ClickHouse /ping answered HTTP ${response.status}`;
  } catch {
    return "ClickHouse is not reachable";
  }
}

export async function openLitContainerSkipReason(
  containerName = "openlit"
): Promise<string | false> {
  try {
    await execFileAsync("docker", ["exec", containerName, "true"], {
      timeout: PROBE_TIMEOUT_MS
    });
    return false;
  } catch {
    return `The ${containerName} container is not running`;
  }
}
