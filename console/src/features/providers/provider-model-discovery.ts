import type {
  ControlApiDiscoveredProviderModel,
  ControlApiModelRecord,
  ControlApiProviderModelDiscovery,
  ControlApiProviderModelsResponse
} from "@simulatorlife/autodev-core";

import { NOT_OBSERVED_STATUS } from "../../components/status/StatusBadge.ts";

const PROVIDER_MODEL_COLLATOR = new Intl.Collator();

export type ProviderModelDiscoveryState =
  | {
      readonly status: "available";
      readonly data: ControlApiProviderModelsResponse;
    }
  | { readonly status: "unavailable"; readonly message: string };

export type ProviderModelDiscoveryView =
  | {
      readonly status: "observed";
      readonly source: string;
      readonly observedAt: string;
      readonly models: readonly ControlApiDiscoveredProviderModel[];
    }
  | {
      readonly status: "stale";
      readonly source: string;
      readonly observedAt: string;
      readonly reason: string;
      readonly models: readonly ControlApiDiscoveredProviderModel[];
    }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: typeof NOT_OBSERVED_STATUS; readonly reason: string };

export type ProviderModelAvailability =
  | { readonly status: "observed"; readonly source: string }
  | { readonly status: "stale"; readonly reason: string }
  | {
      readonly status: "unsupported";
      readonly reason: string;
      readonly discoveryStatus: "observed" | "stale";
    }
  | { readonly status: "not-listed"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: typeof NOT_OBSERVED_STATUS; readonly reason: string };

export interface UnsupportedProviderModel {
  readonly provider: string;
  readonly id: string;
  readonly displayName: string | null;
  readonly reason: string;
  readonly discoveryStatus: "observed" | "stale";
}

export interface ProviderModelRow {
  readonly id: string;
  readonly provider: string;
  readonly tiers: readonly string[];
  readonly displayName: string | null;
  readonly enablement: ControlApiModelRecord["enablement"] | null;
  readonly availability: ProviderModelAvailability;
}

export interface ProviderDiscoverySummary {
  readonly provider: string;
  readonly status: ProviderModelDiscoveryView["status"];
  readonly modelCount: number | null;
  readonly reason: string | null;
}

export function providerModelDiscoveryView(
  state: ProviderModelDiscoveryState,
  provider: string
): ProviderModelDiscoveryView {
  if (state.status === "unavailable") {
    return { status: NOT_OBSERVED_STATUS, reason: state.message };
  }
  const entry = state.data.providers.find(
    (candidate) => candidate.provider === provider
  );
  if (entry === undefined) {
    return {
      status: NOT_OBSERVED_STATUS,
      reason: "Runtime did not report model-discovery state for this provider."
    };
  }
  return discoveryView(entry.discovery);
}

export function providerModelChoices(
  state: ProviderModelDiscoveryState,
  provider: string
): readonly ControlApiDiscoveredProviderModel[] {
  const discovery = providerModelDiscoveryView(state, provider);
  if (discovery.status !== "observed") return [];
  return discovery.models.filter(
    (model) => model.routeability.status === "supported"
  );
}

export function providerModelAvailability(
  state: ProviderModelDiscoveryState,
  provider: string,
  modelId: string
): ProviderModelAvailability {
  const discovery = providerModelDiscoveryView(state, provider);
  if (discovery.status === NOT_OBSERVED_STATUS) return discovery;
  if (discovery.status === "unavailable") return discovery;
  const reported = discovery.models.find((model) => model.id === modelId);
  if (reported?.routeability.status === "unsupported") {
    return {
      status: "unsupported",
      reason: reported.routeability.reason,
      discoveryStatus: discovery.status
    };
  }
  if (discovery.status === "stale") {
    return { status: "stale", reason: discovery.reason };
  }
  if (reported === undefined) {
    return {
      status: "not-listed",
      reason: "The current provider listing does not include this model."
    };
  }
  return { status: "observed", source: discovery.source };
}

export function providerModelAvailabilityLabel(
  availability: ProviderModelAvailability
): string {
  switch (availability.status) {
    case "observed": {
      return "Observed";
    }
    case "stale": {
      return "Stale";
    }
    case "unsupported": {
      return "Unsupported";
    }
    case "not-listed": {
      return "Not listed";
    }
    case "unavailable": {
      return "Unavailable";
    }
    case NOT_OBSERVED_STATUS: {
      return "Not observed";
    }
    default: {
      throw new TypeError("Provider model availability state is invalid.");
    }
  }
}

/** Join routing state to provider-owned availability without guessing either. */
export function providerModelRows(
  models: readonly ControlApiModelRecord[] | null,
  discovery: ProviderModelDiscoveryState
): readonly ProviderModelRow[] {
  const rows = new Map<string, ProviderModelRow>();
  for (const model of models ?? []) {
    const availability = providerModelAvailability(
      discovery,
      model.provider,
      model.id
    );
    if (availability.status === "unsupported") continue;
    rows.set(modelKey(model.provider, model.id), {
      id: model.id,
      provider: model.provider,
      tiers: model.tiers,
      displayName: model.displayName,
      enablement: model.enablement,
      availability
    });
  }

  if (discovery.status === "available") {
    for (const entry of discovery.data.providers) {
      if (entry.discovery.status === "unavailable") continue;
      for (const model of entry.discovery.models) {
        if (model.routeability.status !== "supported") continue;
        const key = modelKey(entry.provider, model.id);
        if (rows.has(key)) continue;
        rows.set(key, {
          id: model.id,
          provider: entry.provider,
          tiers: [],
          displayName: model.displayName,
          enablement: null,
          availability: providerModelAvailability(
            discovery,
            entry.provider,
            model.id
          )
        });
      }
    }
  }

  return [...rows.values()].sort(
    (left, right) =>
      PROVIDER_MODEL_COLLATOR.compare(left.provider, right.provider) ||
      PROVIDER_MODEL_COLLATOR.compare(left.id, right.id)
  );
}

export function unsupportedProviderModels(
  state: ProviderModelDiscoveryState
): readonly UnsupportedProviderModel[] {
  if (state.status === "unavailable") return [];
  return state.data.providers.flatMap(({ provider, discovery }) => {
    if (discovery.status === "unavailable") return [];
    return discovery.models.flatMap((model) =>
      model.routeability.status === "unsupported"
        ? [
            {
              provider,
              id: model.id,
              displayName: model.displayName,
              reason: model.routeability.reason,
              discoveryStatus: discovery.status
            }
          ]
        : []
    );
  });
}

export function providerDiscoverySummaries(
  state: ProviderModelDiscoveryState
): readonly ProviderDiscoverySummary[] {
  if (state.status === "unavailable") return [];
  return state.data.providers.map(({ provider, discovery }) => ({
    provider,
    status: discovery.status,
    modelCount:
      discovery.status === "unavailable" ? null : discovery.models.length,
    reason:
      discovery.status === "unavailable" || discovery.status === "stale"
        ? discovery.reason
        : null
  }));
}

function modelKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

function discoveryView(
  discovery: ControlApiProviderModelDiscovery
): ProviderModelDiscoveryView {
  switch (discovery.status) {
    case "observed": {
      return {
        status: "observed",
        source: discovery.source,
        observedAt: discovery.observedAt,
        models: discovery.models
      };
    }
    case "stale": {
      return {
        status: "stale",
        source: discovery.source,
        observedAt: discovery.observedAt,
        reason: discovery.reason,
        models: discovery.models
      };
    }
    case "unavailable": {
      return { status: "unavailable", reason: discovery.reason };
    }
    default: {
      throw new TypeError("Provider model discovery state is invalid.");
    }
  }
}
