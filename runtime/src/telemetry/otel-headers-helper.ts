/**
The OTLP headers helper native Claude Code runs before it exports.

Claude Code's `otelHeadersHelper` setting names a command whose stdout is a
JSON object of OTLP export headers. AutoDev's OpenLIT receiver requires
`Authorization: Bearer <OPENLIT_OTLP_API_KEY>`, and that key lives only in
the out-of-repository secret file (`$CODEX_HOME/openlit-secrets.env`). This
helper reads it at export time, so the key is never written into
`~/.claude/settings.json`, an environment block or a launch argument.

Without a key the helper fails: Claude Code then reports that telemetry is
not being exported, which is the truthful state, instead of exporting
unauthenticated requests the receiver would reject.
*/

import process from "node:process";

import { isEntryPoint } from "../shared/entry-point.ts";
import { readRuntimeSecret } from "../shared/runtime-secrets.ts";

/**
The headers JSON for the OpenLIT receiver, or null when no key is available.
*/
export function renderOtlpHeaders(
  environment: NodeJS.ProcessEnv = process.env
): string | null {
  const key = readRuntimeSecret("OPENLIT_OTLP_API_KEY", environment);
  return key ? JSON.stringify({ Authorization: `Bearer ${key}` }) : null;
}

if (isEntryPoint(import.meta.url)) {
  const headers = renderOtlpHeaders();
  if (headers === null) {
    process.stderr.write(
      "autodev otel-headers-helper: the OpenLIT OTLP key is not available\n"
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`${headers}\n`);
  }
}
