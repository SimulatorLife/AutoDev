import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredMemoryEmbeddingProvider,
  embeddingTimeoutMs
} from "../src/router/memory-embedding.ts";
import type { ProviderRoute, RoutingPolicy } from "../src/router/routing.ts";

/**
 * Whether memory has vector retrieval at all, decided here.
 *
 * Two functions, and neither had a test. `embeddingTimeoutMs` exists because a
 * too-tight default "silently costs memory quality rather than reporting an
 * error" -- an abort surfaces as `MemoryEmbeddingUnavailableError`, and the
 * documented result is lexical-only retrieval. So a bad override must be
 * ignored rather than forwarded, because the constructor rejects out-of-range
 * timeouts and `configuredMemoryEmbeddingProvider` swallows that rejection by
 * design.
 *
 * `configuredMemoryEmbeddingProvider` decides whether a route is eligible, and
 * the rule that matters is this one: **without a credential, only a loopback
 * route qualifies.** Everything else needs an API key. A route that resolved
 * without one would send embeddings -- derived from memory claims -- to a
 * remote host with nothing to authenticate the request.
 */

const MIN_MS = 100;
const MAX_MS = 30_000;

/** A routing policy that resolves exactly the routes a test declares. */
function routingFor(
  routes: Readonly<Record<string, ProviderRoute | null>>
): Pick<RoutingPolicy, "routeForModel"> {
  return { routeForModel: (model: string) => routes[model] ?? null };
}

function route(overrides: Partial<ProviderRoute> = {}): ProviderRoute {
  return {
    provider: "openai",
    pattern: /^embed/u,
    baseUrl: "https://api.example.com/v1",
    ...overrides
  } as ProviderRoute;
}

const REMOTE_WITH_KEY = routingFor({
  "text-embedding-3-small": route({ envKey: "OPENAI_API_KEY" })
});
const LOCAL_NO_KEY = routingFor({
  "local-embed": route({ baseUrl: "http://127.0.0.1:8080/v1", envKey: null })
});

test("a usable timeout override is returned and an unusable one is not", () => {
  // Ignoring a bad value is the point: forwarding garbage would switch vector
  // retrieval off entirely rather than leaving the adapter on its default.
  assert.equal(
    embeddingTimeoutMs({ AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: "5000" } as NodeJS.ProcessEnv),
    5000
  );
  // The boundaries themselves are inside the range.
  for (const value of [String(MIN_MS), String(MAX_MS)]) {
    assert.equal(
      embeddingTimeoutMs({ AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: value } as NodeJS.ProcessEnv),
      Number(value),
      `${value} is inside the range and must be honoured`
    );
  }

  for (const value of [
    undefined,
    "",
    "   ",
    String(MIN_MS - 1),
    String(MAX_MS + 1),
    "-1",
    "not a number",
    "NaN"
  ]) {
    assert.equal(
      embeddingTimeoutMs(
        { AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: value } as NodeJS.ProcessEnv
      ),
      undefined,
      `${JSON.stringify(value)} must leave the adapter on its default`
    );
  }
});

test("an embedding model has to be declared before anything is eligible", () => {
  assert.equal(
    configuredMemoryEmbeddingProvider({} as NodeJS.ProcessEnv, REMOTE_WITH_KEY),
    undefined,
    "no declared model means no embedding provider at all"
  );
  assert.equal(
    configuredMemoryEmbeddingProvider(
      { AUTODEV_MEMORY_EMBEDDING_MODEL: "   " } as NodeJS.ProcessEnv,
      REMOTE_WITH_KEY
    ),
    undefined,
    "a blank model is not a model"
  );
  // Routing is consulted with the model, and an absent one must not be filled
  // in. The policy below resolves *any* model, so only the absence of the
  // declaration can make this ineligible.
  assert.equal(
    configuredMemoryEmbeddingProvider(
      {} as NodeJS.ProcessEnv,
      { routeForModel: () => route({ baseUrl: "http://127.0.0.1:8080/v1", envKey: null }) }
    ),
    undefined,
    "an undeclared model must not inherit a default and become eligible"
  );
  assert.equal(
    configuredMemoryEmbeddingProvider(
      { AUTODEV_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small" } as NodeJS.ProcessEnv,
      routingFor({})
    ),
    undefined,
    "a declared model with no matching route is not eligible"
  );
});

test("a model name past the bound is refused before routing is consulted", () => {
  // Routing is a lookup into operator configuration; a 4 KiB model string is
  // not a model, and there is no reason to run it through.
  let consulted = false;
  const watched = {
    routeForModel: (model: string) => {
      consulted = true;
      return route();
    }
  } satisfies Pick<RoutingPolicy, "routeForModel">;

  assert.equal(
    configuredMemoryEmbeddingProvider(
      { AUTODEV_MEMORY_EMBEDDING_MODEL: "e".repeat(257) } as NodeJS.ProcessEnv,
      watched
    ),
    undefined
  );
  assert.equal(consulted, false, "an over-long model must not reach routing");
});

test("a remote route needs a credential, and a local one does not", () => {
  const withKey = configuredMemoryEmbeddingProvider(
    {
      AUTODEV_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
      OPENAI_API_KEY: "sk-test"
    } as NodeJS.ProcessEnv,
    REMOTE_WITH_KEY
  );
  assert.ok(withKey, "a remote route with a key is eligible");

  // The rule this whole function turns on.
  const withoutKey = configuredMemoryEmbeddingProvider(
    { AUTODEV_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small" } as NodeJS.ProcessEnv,
    REMOTE_WITH_KEY
  );
  assert.equal(
    withoutKey,
    undefined,
    "a remote route with no credential must not be eligible"
  );
  // A blank credential is no credential.
  assert.equal(
    configuredMemoryEmbeddingProvider(
      {
        AUTODEV_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
        OPENAI_API_KEY: "   "
      } as NodeJS.ProcessEnv,
      REMOTE_WITH_KEY
    ),
    undefined
  );

  const local = configuredMemoryEmbeddingProvider(
    { AUTODEV_MEMORY_EMBEDDING_MODEL: "local-embed" } as NodeJS.ProcessEnv,
    LOCAL_NO_KEY
  );
  assert.ok(local, "a loopback route needs no credential");
});

test("a remote route that names no credential variable is never eligible", () => {
  // `envKey: null` means "this route needs no credential", which is what makes a
  // loopback route usable without one. A remote route with the same declaration
  // is asking for anonymous access to a remote host, so it stays ineligible
  // however many credentials happen to be sitting in the environment -- the
  // route has to say which one it wants.
  const policy = routingFor({
    "embed-anonymous-remote": route({
      baseUrl: "https://api.example.com/v1",
      envKey: null
    })
  });

  assert.equal(
    configuredMemoryEmbeddingProvider(
      {
        AUTODEV_MEMORY_EMBEDDING_MODEL: "embed-anonymous-remote",
        OPENAI_API_KEY: "sk-test",
        ANTHROPIC_API_KEY: "sk-other"
      } as NodeJS.ProcessEnv,
      policy
    ),
    undefined,
    "an anonymous remote route must not be made eligible by an unrelated credential"
  );
});

test("only the three local spellings count as loopback", () => {
  for (const baseUrl of [
    "http://127.0.0.1:8080/v1",
    "http://localhost:8080/v1",
    "http://[::1]:8080/v1",
    "https://127.0.0.1:8080/v1"
  ]) {
    const policy = routingFor({
      "embed-any": route({ baseUrl, envKey: null })
    });
    assert.ok(
      configuredMemoryEmbeddingProvider(
        { AUTODEV_MEMORY_EMBEDDING_MODEL: "embed-any" } as NodeJS.ProcessEnv,
        policy
      ),
      `${baseUrl} should count as local`
    );
  }

  for (const baseUrl of [
    "https://api.example.com/v1",
    // The cloud instance-metadata address.
    "http://169.254.169.254/v1",
    "http://127.0.0.1.evil.example.com/v1",
    "http://user:pass@127.0.0.1:8080/v1",
    "ftp://127.0.0.1:8080/v1",
    "not a url at all"
  ]) {
    const policy = routingFor({
      "embed-any": route({ baseUrl, envKey: null })
    });
    assert.equal(
      configuredMemoryEmbeddingProvider(
        { AUTODEV_MEMORY_EMBEDDING_MODEL: "embed-any" } as NodeJS.ProcessEnv,
        policy
      ),
      undefined,
      `${baseUrl} must not count as a local route`
    );
  }
});

test("a route that declares a credential must actually have one in the environment", () => {
  // `envKey: null` means the route needs none; a named key means it does.
  const policy = routingFor({
    "embed-keyed": route({ baseUrl: "http://127.0.0.1:8080/v1", envKey: "MY_KEY" })
  });

  assert.ok(
    configuredMemoryEmbeddingProvider(
      { AUTODEV_MEMORY_EMBEDDING_MODEL: "embed-keyed", MY_KEY: "k" } as NodeJS.ProcessEnv,
      policy
    ),
    "a named key that is present makes a local route eligible"
  );
  assert.equal(
    configuredMemoryEmbeddingProvider(
      { AUTODEV_MEMORY_EMBEDDING_MODEL: "embed-keyed" } as NodeJS.ProcessEnv,
      policy
    ),
    undefined,
    "a named key that is absent makes the route ineligible, local or not"
  );
});

test("a route the provider itself refuses is swallowed, not thrown", () => {
  // `embeddingProvider` catches the constructor's rejection by design: bad
  // optional embedding configuration must not disable lexical memory.
  //
  // This input reaches that catch rather than an earlier guard. It is a
  // loopback URL, so `isLoopbackRoute` passes it -- that check looks at scheme,
  // host and credentials but not at a query string, and the provider rejects
  // one.
  const policy = routingFor({
    "embed-query": route({
      baseUrl: "http://127.0.0.1:8080/v1?tenant=acme",
      envKey: null
    })
  });

  assert.doesNotThrow(() => {
    assert.equal(
      configuredMemoryEmbeddingProvider(
        { AUTODEV_MEMORY_EMBEDDING_MODEL: "embed-query" } as NodeJS.ProcessEnv,
        policy
      ),
      undefined,
      "a provider that would reject the endpoint yields no provider, quietly"
    );
  });
});

test("a usable timeout override is forwarded and a rejected one is left alone", () => {
  const withTimeout = configuredMemoryEmbeddingProvider(
    {
      AUTODEV_MEMORY_EMBEDDING_MODEL: "local-embed",
      AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: "20000"
    } as NodeJS.ProcessEnv,
    LOCAL_NO_KEY
  );
  assert.ok(withTimeout, "a valid timeout must not make the route ineligible");

  // The point of `embeddingTimeoutMs` returning `undefined`: a value the
  // provider would reject must leave the route eligible on its default rather
  // than switch vector retrieval off.
  for (const value of ["50", "60000", "not a number"]) {
    assert.ok(
      configuredMemoryEmbeddingProvider(
        {
          AUTODEV_MEMORY_EMBEDDING_MODEL: "local-embed",
          AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: value
        } as NodeJS.ProcessEnv,
        LOCAL_NO_KEY
      ),
      `${JSON.stringify(value)} must be ignored, not forwarded and rejected`
    );
  }
});