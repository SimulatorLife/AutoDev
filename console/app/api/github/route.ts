import type { NextRequest } from "next/server.js";

import { handleGithubMutationForm } from "../../../src/lib/server/github-mutations.ts";

/**
 * POST-only Console route for allowlisted GitHub workflow mutations.
 *
 * All request validation (same-origin `Origin`, `Sec-Fetch-Site`, bounded
 * form body, short-lived server-HMAC confirmation token, explicit
 * `confirm=yes`) and the typed, allowlisted forward to the Runtime Control
 * API (`POST /control/github/mutations`) live in
 * `src/lib/server/github-mutations.ts`. This route only binds that handler;
 * it never reads or forwards GitHub tokens, and exporting only `POST` makes
 * every other HTTP method return HTTP 405 Method Not Allowed.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  return handleGithubMutationForm(request);
}
