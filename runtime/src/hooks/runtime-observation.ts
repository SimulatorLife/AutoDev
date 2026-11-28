/**
Post a hook's observation to the local Runtime.

The post carries the Runtime's local enrollment credential, which authorizes
observations only. It is best effort: without a credential, or with an
unusable Router port, nothing is sent, and the caller decides what a failed
post means for the host (always nothing -- observation never blocks work).
*/
import { homedir } from "node:os";
import path from "node:path";

import { readLocalAdmission } from "../mcp/gateway-admission.ts";

export async function postRuntimeObservation(
  pathname: string,
  observation: unknown,
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const home = environment.HOME?.trim() || homedir();
  const codexHome = environment.CODEX_HOME?.trim() || path.join(home, ".codex");
  const admission = readLocalAdmission(codexHome);
  if (!admission) return;
  const port = Number(environment.CODEX_MODEL_ROUTER_PORT ?? "4100");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return;
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${admission.key}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(observation),
    redirect: "error",
    signal: AbortSignal.timeout(1000)
  });
  await response.body?.cancel();
}
