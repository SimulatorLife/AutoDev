import { handleEvaluationAction } from "../../../src/lib/server/evaluation-actions.ts";

/**
 * POST-only Console route for evaluation definition saves, deletes, and runs.
 *
 * Same-origin `Origin`/`Sec-Fetch-Site` checks, bounded bodies, short-lived
 * server-HMAC form tokens, and the typed forward to the Runtime Control API
 * (`/control/evaluations`) live in `src/lib/server/evaluation-actions.ts`.
 * Exporting only `POST` makes every other method return HTTP 405.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handleEvaluationAction(request);
}
