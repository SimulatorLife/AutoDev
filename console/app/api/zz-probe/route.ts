/**
 * TEMPORARY diagnostic route -- delete before commit.
 *
 * Times the providers page's read set from inside the Next.js server, so the
 * Console's own fetch path can be compared with a plain Node client.
 */

import { NextResponse } from "next/server.js";

import {
  fetchModels,
  fetchProviderModelDiscovery,
  fetchProviderVersions,
  fetchProviders,
  fetchRuntime,
  readControlApiConfig
} from "../../../src/lib/server/control-api.ts";
import { loadOpenLITUsage } from "../../../src/lib/server/openlit-usage.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function timed<T>(
  label: string,
  run: () => Promise<T>
): Promise<{ label: string; ms: number; ok: boolean }> {
  const started = performance.now();
  try {
    const result = await run();
    const ok =
      typeof result === "object" &&
      result !== null &&
      "kind" in result &&
      (result as { kind: string }).kind === "ok";
    return { label, ms: Math.round(performance.now() - started), ok };
  } catch (error) {
    return {
      label,
      ms: Math.round(performance.now() - started),
      ok: false
    };
  }
}

export async function GET(): Promise<NextResponse> {
  const config = readControlApiConfig();
  if (!config) {
    return NextResponse.json({ error: "no config" }, { status: 500 });
  }

  const single = await Promise.all([
    timed("providers", () => fetchProviders(config)),
    timed("models", () => fetchModels(config)),
    timed("provider-models", () => fetchProviderModelDiscovery(config)),
    timed("provider-versions", () => fetchProviderVersions(config)),
    timed("runtime", () => fetchRuntime(config))
  ]);

  const fanout = await Promise.all([
    timed("fanout:providers", () => fetchProviders(config)),
    timed("fanout:models", () => fetchModels(config)),
    timed("fanout:provider-models", () =>
      fetchProviderModelDiscovery(config)
    ),
    timed("fanout:provider-versions", () => fetchProviderVersions(config)),
    timed("fanout:runtime", () => fetchRuntime(config))
  ]);

  const usage = await timed("openlit:7D-provider", () =>
    loadOpenLITUsage({ range: "7D", values: { provider: ["antigravity"] } })
  );

  return NextResponse.json({
    single,
    fanout,
    usage,
    node: process.version,
    pid: process.pid
  });
}
