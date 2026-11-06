/**
 * Which provider owns a concrete model id.
 *
 * The router's built-in routes (`runtime/src/router/routing.ts`) and the
 * provider lifecycle owners (`runtime/src/platform/*-ensure.ts`, which may not
 * import the router) must agree on this, so the patterns live here once.
 * `config/model-routing.json` carries the same patterns as editable route
 * config; `tests/router/model-router.test.ts` keeps the shipped file in step.
 *
 * Claude Opus and Sonnet are served by two providers: the Claude subscription
 * bridge and the Antigravity (`agy`) CLI. Their ids never collide because each
 * side has its own naming convention. Anthropic ids are lowercase,
 * hyphen-separated and carry no reasoning suffix (`claude-opus-5-5`); agy
 * encodes reasoning depth in the id itself, exactly as `agy models` lists it
 * (`claude-opus-5-5-high`, `claude-sonnet-5-5-medium`). An effort-suffixed
 * Claude id therefore belongs to Antigravity and every other Claude id to the
 * Claude bridge, so a model id alone names its provider whatever the route
 * order.
 */

/** Gemini ids, plus agy's effort-suffixed Claude ids (`claude-opus-5-5-high`). */
export const ANTIGRAVITY_MODEL_PATTERN =
  /^(gemini-[A-Za-z0-9][A-Za-z0-9.-]*|claude-[a-z0-9-]*[a-z0-9]-(?:low|medium|high))$/;

export type AntigravityQuotaPool = "first_party" | "third_party";

/** Antigravity's currently routed Gemini and Claude families use separate quota pools. */
export function providerQuotaPool(
  provider: string,
  model: string | null
): AntigravityQuotaPool | null {
  if (provider !== "antigravity" || model === null) return null;
  if (!ANTIGRAVITY_MODEL_PATTERN.test(model)) return null;
  if (model.startsWith("gemini-")) return "first_party";
  if (model.startsWith("claude-")) return "third_party";
  return null;
}

/**
 * Claude family aliases and Anthropic's lowercase, hyphen-separated ids --
 * never `claude-opus-5.5`, and never an agy effort-suffixed id.
 */
export const CLAUDE_MODEL_PATTERN =
  /^(sonnet|opus|haiku|claude-(?![a-z0-9-]*-(?:low|medium|high)$)[a-z0-9-]*[a-z0-9])$/;

/** Every MiniMax model id, in MiniMax's own casing (`MiniMax-M3`, `MiniMax-M3.1-Flash-Preview`). */
export const MINIMAX_MODEL_PATTERN = /^MiniMax-[A-Za-z0-9][A-Za-z0-9.-]*$/;

/**
 * The chat sites the opencli bridge serves, each as one model.
 *
 * opencli drives a site's own web chat through the user's signed-in browser,
 * so a "model" here is a site, not a weights version: `opencli-chatgpt` is
 * whatever model chatgpt.com answers with for that account. The list is the
 * single definition of which sites AutoDev routes to; the bridge's site
 * registry (`runtime/src/providers/opencli-turn.ts`) must cover each one.
 */
export const OPENCLI_SITES = ["chatgpt", "gemini"] as const;

export type OpencliSite = (typeof OPENCLI_SITES)[number];

/** `opencli-<site>` for every served site, and nothing else. */
export const OPENCLI_MODEL_PATTERN = new RegExp(
  `^opencli-(?:${OPENCLI_SITES.join("|")})$`
);

/** The site an `opencli-<site>` model id names, or null for any other id. */
export function opencliSiteForModel(model: unknown): OpencliSite | null {
  if (typeof model !== "string" || !OPENCLI_MODEL_PATTERN.test(model))
    return null;
  return model.slice("opencli-".length) as OpencliSite;
}
