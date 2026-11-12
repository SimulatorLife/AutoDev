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
 * order. The same holds for GPT: agy's open-weight GPT ids are
 * `gpt-oss-<size>-<effort>` and Codex never serves a `gpt-oss-` id, so the
 * Codex pattern excludes that prefix.
 *
 * The one Antigravity service (the `agy` CLI behind its bridge on :4002) is
 * split into one provider per subscription quota: agy meters Gemini, Argon,
 * and Claude/GPT-OSS separately, each with its own 5-hour and weekly limits,
 * so each is a provider with its own models, routing, cooldowns and usage.
 */

import {
  ANTIGRAVITY_PROVIDERS,
  type AntigravityProvider
} from "@simulatorlife/autodev-core";

/** agy's Gemini ids other than Argon (`gemini-3.8-flash-medium`). */
export const ANTIGRAVITY_GEMINI_MODEL_PATTERN =
  /^gemini-(?![0-9][0-9.]*-argon(?:-|$))[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** agy's Argon ids, which carry their own quota (`gemini-4-argon-high`). */
export const ANTIGRAVITY_ARGON_MODEL_PATTERN =
  /^gemini-[0-9][0-9.]*-argon-(?:low|medium|high)$/;

/** agy's effort-suffixed Claude and GPT-OSS ids, which share one quota. */
export const ANTIGRAVITY_CLAUDE_GPT_MODEL_PATTERN =
  /^(?:claude-[a-z0-9-]*[a-z0-9]|gpt-oss-[a-z0-9-]*[a-z0-9])-(?:low|medium|high)$/;

/**
 * The model ids each Antigravity provider serves. Core owns the provider ids
 * (`ANTIGRAVITY_PROVIDERS`), because the Console shares them.
 */
export const ANTIGRAVITY_PROVIDER_PATTERNS: Readonly<
  Record<AntigravityProvider, RegExp>
> = Object.freeze({
  "antigravity-gemini": ANTIGRAVITY_GEMINI_MODEL_PATTERN,
  "antigravity-argon": ANTIGRAVITY_ARGON_MODEL_PATTERN,
  "antigravity-claude-gpt": ANTIGRAVITY_CLAUDE_GPT_MODEL_PATTERN
});

/** The Antigravity provider that owns an agy model id, or null. */
export function antigravityProvider(
  model: unknown
): AntigravityProvider | null {
  if (typeof model !== "string") return null;
  for (const provider of ANTIGRAVITY_PROVIDERS)
    if (ANTIGRAVITY_PROVIDER_PATTERNS[provider].test(model)) return provider;
  return null;
}

/** Codex's own ids. `gpt-oss-` ids belong to Antigravity. */
export const CODEX_MODEL_PATTERN =
  /^(gpt-(?!oss-)[A-Za-z0-9][A-Za-z0-9.-]*|o[1-9][A-Za-z0-9.-]*|codex-[A-Za-z0-9][A-Za-z0-9.-]*)$/;

/**
 * Claude family aliases and Anthropic's lowercase, hyphen-separated ids --
 * never `claude-opus-5.5`, and never an agy effort-suffixed id.
 */
export const CLAUDE_MODEL_PATTERN =
  /^(sonnet|opus|haiku|claude-(?![a-z0-9-]*-(?:low|medium|high)$)[a-z0-9-]*[a-z0-9])$/;

/** Every MiniMax model id, in MiniMax's own casing (`MiniMax-M3`, `MiniMax-M3.1-Flash-Preview`). */
export const MINIMAX_MODEL_PATTERN = /^MiniMax-[A-Za-z0-9][A-Za-z0-9.-]*$/;

/**
 * Whether a lifecycle request names a model served by the given provider.
 * Preserve each provider's request normalization independently of routing.
 */
export function isProviderRequestModel(
  input: string,
  provider: "antigravity" | "claude" | "minimax"
): boolean {
  try {
    const request: unknown = JSON.parse(input);
    if (!request || typeof request !== "object" || Array.isArray(request))
      return false;
    const model = (request as Record<string, unknown>).model;
    if (typeof model !== "string") return false;

    if (provider === "antigravity")
      return antigravityProvider(model.trim().toLowerCase()) !== null;
    if (provider === "claude") return CLAUDE_MODEL_PATTERN.test(model.trim());
    return MINIMAX_MODEL_PATTERN.test(model);
  } catch {
    return false;
  }
}

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
