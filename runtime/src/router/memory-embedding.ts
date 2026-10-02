import { OpenAICompatibleMemoryEmbeddingProvider } from "../memory/openai-compatible-embedding.ts";
import {
  type ProviderRoute,
  ROUTING_POLICY,
  type RoutingPolicy
} from "./routing.ts";

const LOCAL_ROUTER_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_EMBEDDING_MODEL_LENGTH = 256;

/** Resolve embeddings through a model already declared in AutoDev routing. */
export function configuredMemoryEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
  routing: Pick<RoutingPolicy, "routeForModel"> = ROUTING_POLICY
): OpenAICompatibleMemoryEmbeddingProvider | undefined {
  let provider: OpenAICompatibleMemoryEmbeddingProvider | undefined;
  const model = env.AUTODEV_MEMORY_EMBEDDING_MODEL?.trim();
  if (model && model.length <= MAX_EMBEDDING_MODEL_LENGTH) {
    const route = routing.routeForModel(model);
    if (route) {
      const apiKey = route.envKey ? env[route.envKey]?.trim() : undefined;
      if ((!route.envKey || apiKey) && (apiKey || isLoopbackRoute(route))) {
        try {
          provider = new OpenAICompatibleMemoryEmbeddingProvider({
            endpoint: route.baseUrl,
            model,
            provider: route.provider,
            ...(apiKey ? { apiKey } : {})
          });
        } catch {
          // Bad optional embedding configuration must not disable lexical memory.
        }
      }
    }
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
