/**
The provider model discovery contract, as one schema.

The Runtime produces this response, the Console reads it, and the Console's
startup preflight checks that the Runtime it is about to talk to speaks the
same contract. Those three places used to spell the contract between them:
two hand-written validators that did not agree with each other, and a set of
types that described a shape nobody validated against. One schema, owned
here, is now the only statement of it -- the producers name its schema id,
the readers validate against it, and the types are read out of it.

The shape itself is unchanged. What this fixes is that the two validators
disagreed: the preflight required a provider id to match the routing id
pattern, and the Console did not, while the Console required a provider id to
be at most 128 characters and the preflight did not. One spelling of the
contract is one answer.
*/
import { z } from "zod";

/**
The routing id of a provider: a name, not a path or a display label.
*/
export const CONTROL_API_PROVIDER_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
The id a provider gives one of its own models.
*/
export const PROVIDER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

/**
The contract revision the Runtime and the Console must agree on.
*/
export const CONTROL_API_PROVIDER_MODEL_DISCOVERY_SCHEMA_ID =
  "autodev-control-provider-model-discovery-v1" as const;

/**
A text that says something: not empty, and not only whitespace.
*/
const saidSomething = z.string().refine((value) => value.trim().length > 0, {
  message: "A text that carries a reason must say something."
});

/**
A timestamp in canonical form: an instant that round-trips through ISO 8601
without losing its own spelling. A timestamp that only parses is not the same
value as one that was written down, and two readers that disagree about the
spelling disagree about the fact.
*/
export const canonicalTimestampSchema = z
  .string()
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    { message: "A timestamp must be a canonical ISO 8601 instant." }
  );

/**
A provider's own model, and whether this Runtime can route it.
*/
const supportedRouteabilitySchema = z.object({
  status: z.literal("supported")
});

const unsupportedRouteabilitySchema = z.object({
  status: z.literal("unsupported"),
  reason: saidSomething
});

export const discoveredProviderModelSchema = z.object({
  id: z
    .string()
    .regex(PROVIDER_MODEL_ID_PATTERN)
    .refine((value) => value.trim() === value, {
      message: "A model id must not carry surrounding whitespace."
    }),
  displayName: z.string().nullable(),
  routeability: z.discriminatedUnion("status", [
    supportedRouteabilitySchema,
    unsupportedRouteabilitySchema
  ])
});

/**
Provider-owned model availability, kept separate from operator routing.

`observed` is a listing the provider itself gave. `stale` is a listing this
Runtime still holds but can no longer vouch for. `unavailable` is no listing
at all, and says why.
*/
export const providerModelDiscoverySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("observed"),
    source: saidSomething,
    observedAt: canonicalTimestampSchema,
    lastAttemptAt: canonicalTimestampSchema,
    models: z.array(discoveredProviderModelSchema)
  }),
  z.object({
    status: z.literal("stale"),
    source: saidSomething,
    observedAt: canonicalTimestampSchema,
    lastAttemptAt: canonicalTimestampSchema,
    reason: saidSomething,
    models: z.array(discoveredProviderModelSchema)
  }),
  z.object({
    status: z.literal("unavailable"),
    source: saidSomething.nullable(),
    lastAttemptAt: canonicalTimestampSchema.nullable(),
    reason: saidSomething
  })
]);

/**
One provider's entry in the discovery response.

A provider may list one model only once. Two providers may each list the
same model -- both can serve a model with the same id -- so the rule is per
provider, not per response.
*/
export const providerModelDiscoveryEntrySchema = z
  .object({
    provider: z
      .string()
      .regex(CONTROL_API_PROVIDER_ID_PATTERN)
      .refine((value) => value.trim() === value, {
        message: "A provider id must not carry surrounding whitespace."
      }),
    discovery: providerModelDiscoverySchema
  })
  .refine(
    (entry) => {
      if (entry.discovery.status === "unavailable") return true;
      const ids = entry.discovery.models.map((model) => model.id);
      return new Set(ids).size === ids.length;
    },
    { message: "A provider may list one model only once." }
  );

/**
The whole response.

A provider may answer only once.
*/
export const controlApiProviderModelsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROVIDER_MODEL_DISCOVERY_SCHEMA_ID),
    source: z.literal("runtime-provider-discovery"),
    providers: z.array(providerModelDiscoveryEntrySchema)
  })
  .refine(
    (response) =>
      new Set(response.providers.map((entry) => entry.provider)).size ===
      response.providers.length,
    { message: "A provider may answer only once." }
  );

export type ControlApiDiscoveredProviderModel = z.infer<
  typeof discoveredProviderModelSchema
>;
export type ControlApiProviderModelDiscovery = z.infer<
  typeof providerModelDiscoverySchema
>;
export type ControlApiProviderModelDiscoveryEntry = z.infer<
  typeof providerModelDiscoveryEntrySchema
>;
export type ControlApiProviderModelsResponse = z.infer<
  typeof controlApiProviderModelsResponseSchema
>;
