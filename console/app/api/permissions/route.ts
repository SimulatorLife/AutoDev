/** Retired write endpoint. No credentials, forwarding, or compatibility writes. */
export function POST(): Response {
  return new Response(null, { status: 410 });
}
