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
 * The web chat sites the opencli bridge serves, each as its own provider.
 *
 * opencli drives a site's own web chat through the user's signed-in browser.
 * Each site is a provider (`opencli-chatgpt`, `opencli-gemini`) with the
 * models that site offers, so the Console assigns a site model per role like
 * any other provider's. A model id is `<provider>-<site model>`:
 * `opencli-chatgpt-advanced` asks ChatGPT at its Advanced level and
 * `opencli-gemini-3.1-pro` asks Gemini's 3.1 Pro. The prefix keeps every id
 * distinct from the other providers' (an Antigravity id is `gemini-...`).
 * Both providers are served by the one bridge (`runtime/src/providers/
 * opencli.ts`), whose site registry must cover each site.
 */
export const OPENCLI_PROVIDER_SITES = Object.freeze({
  "opencli-chatgpt": "chatgpt",
  "opencli-gemini": "gemini"
} as const);

export type OpencliProvider = keyof typeof OPENCLI_PROVIDER_SITES;
export type OpencliSite = (typeof OPENCLI_PROVIDER_SITES)[OpencliProvider];

export const OPENCLI_PROVIDERS = Object.keys(
  OPENCLI_PROVIDER_SITES
) as OpencliProvider[];

export const OPENCLI_SITES = Object.values(
  OPENCLI_PROVIDER_SITES
) as OpencliSite[];

/** An opencli site's own model name: lowercase, digits, dots and dashes. */
const SITE_MODEL = String.raw`[a-z0-9][a-z0-9.-]*`;

/** `opencli-chatgpt-<level>`: a ChatGPT model or intelligence level. */
export const OPENCLI_CHATGPT_MODEL_PATTERN = new RegExp(
  `^opencli-chatgpt-${SITE_MODEL}$`
);

/** `opencli-gemini-<model>`: a model `opencli gemini models` lists. */
export const OPENCLI_GEMINI_MODEL_PATTERN = new RegExp(
  `^opencli-gemini-${SITE_MODEL}$`
);

export interface OpencliModel {
  readonly provider: OpencliProvider;
  readonly site: OpencliSite;
  /** The site's own model name, as opencli takes it (`3.1-pro`, `advanced`). */
  readonly siteModel: string;
}

/** The provider, site and site model an opencli model id names, or null. */
export function opencliModel(model: unknown): OpencliModel | null {
  if (typeof model !== "string") return null;
  for (const provider of OPENCLI_PROVIDERS) {
    const prefix = `${provider}-`;
    if (
      model.startsWith(prefix) &&
      new RegExp(`^${SITE_MODEL}$`).test(model.slice(prefix.length))
    )
      return {
        provider,
        site: OPENCLI_PROVIDER_SITES[provider],
        siteModel: model.slice(prefix.length)
      };
  }
  return null;
}

/** The model id for a site model of an opencli provider. */
export function opencliModelId(
  provider: OpencliProvider,
  siteModel: string
): string {
  return `${provider}-${siteModel}`;
}
