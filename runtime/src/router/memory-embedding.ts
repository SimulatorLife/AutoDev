import {
  MAX_EMBEDDING_MODEL_LENGTH,
  MAX_EMBEDDING_TIMEOUT_MS,
  MIN_EMBEDDING_TIMEOUT_MS,
  OpenAICompatibleMemoryEmbeddingProvider
} from "@simulatorlife/autodev-runtime/memory";
import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";

import {
  type ProviderRoute,
  ROUTING_POLICY,
  type RoutingPolicy
} from "./routing.ts";

const LOCAL_ROUTER_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The embedding timeout, from `AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS`.
 *
 * This is the one embedding knob that genuinely varies per deployment. The
 * adapter's fixed 5s default suits neither extreme: a hosted embedding API under
 * cold start routinely takes longer, and a local model server on CPU takes far
 * longer. Aborting early is not a loud failure either -- it surfaces as
 * `MemoryEmbeddingUnavailableError`, and the documented result is lexical-only
 * retrieval, so a too-tight default silently costs memory quality rather than
 * reporting an error.
 *
 * An unusable value returns `undefined` and leaves the adapter on its default,
 * rather than being forwarded. The constructor rejects an out-of-range timeout,
 * and `configuredMemoryEmbeddingProvider` swallows that rejection by design, so
 * forwarding garbage would switch vector retrieval off entirely instead of
 * ignoring a bad override.
 */
export function embeddingTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS;
  const parsed = raw?.trim() ? parseNonNegativeInteger(raw, -1) : -1;
  return parsed >= MIN_EMBEDDING_TIMEOUT_MS &&
    parsed <= MAX_EMBEDDING_TIMEOUT_MS
    ? parsed
    : undefined;
}

/** Resolve embeddings through a model already declared in AutoDev routing. */
export function configuredMemoryEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
  routing: Pick<RoutingPolicy, "routeForModel"> = ROUTING_POLICY
): OpenAICompatibleMemoryEmbeddingProvider | undefined {
  const model = env.AUTODEV_MEMORY_EMBEDDING_MODEL?.trim() ?? "";
  const route =
    model.length > 0 && model.length <= MAX_EMBEDDING_MODEL_LENGTH
      ? routing.routeForModel(model)
      : null;
  const apiKey = route?.envKey ? env[route.envKey]?.trim() : undefined;
  const eligible =
    route !== null &&
    (!route.envKey || apiKey) &&
    // Without a credential the route only qualifies if it is local.
    (apiKey || isLoopbackRoute(route));
  return eligible && route
    ? embeddingProvider(route, model, apiKey, embeddingTimeoutMs(env))
    : undefined;
}

function embeddingProvider(
  route: ProviderRoute,
  model: string,
  apiKey: string | undefined,
  timeoutMs: number | undefined
): OpenAICompatibleMemoryEmbeddingProvider | undefined {
  let provider: OpenAICompatibleMemoryEmbeddingProvider | undefined;
  try {
    provider = new OpenAICompatibleMemoryEmbeddingProvider({
      endpoint: route.baseUrl,
      model,
      provider: route.provider,
      ...(apiKey ? { apiKey } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
  } catch {
    // Bad optional embedding configuration must not disable lexical memory.
  }
  return provider;
}

function isLoopbackRoute(route: ProviderRoute): boolean {
  try {
    const endpoint = new URL(route.baseUrl);
    return (
      (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
      LOCAL_ROUTER_HOSTS.has(endpoint.hostname) &&
      !endpoint.username &&
      !endpoint.password
    );
  } catch {
    return false;
  }
}
