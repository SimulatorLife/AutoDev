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

/**
 * Claude family aliases and Anthropic's lowercase, hyphen-separated ids --
 * never `claude-opus-5.5`, and never an agy effort-suffixed id.
 */
export const CLAUDE_MODEL_PATTERN =
  /^(sonnet|opus|haiku|claude-(?![a-z0-9-]*-(?:low|medium|high)$)[a-z0-9-]*[a-z0-9])$/;
