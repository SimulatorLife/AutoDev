/** Retired write-only route. Never forward a hook declaration mutation. */
export function POST(): Response {
  return new Response(null, { status: 410 });
}
