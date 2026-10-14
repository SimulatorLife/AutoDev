import React from "react";

import {
  NOT_OBSERVED_STATUS,
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";
import {
  type ProviderModelAvailability,
  providerModelAvailabilityLabel,
  type ProviderModelDiscoveryView
} from "./provider-model-discovery.ts";

export function ProviderModelAvailabilityBadge({
  availability
}: {
  readonly availability: ProviderModelAvailability;
}): React.JSX.Element {
  let status: StatusBadgeVariant;
  let title: string;
  switch (availability.status) {
    case "observed": {
      status = "valid";
      title = `Current provider listing: ${availability.source}.`;
      break;
    }
    case "not-observed": {
      status = NOT_OBSERVED_STATUS;
      title = availability.reason;
      break;
    }
    default: {
      status = "unavailable";
      title = availability.reason;
      break;
    }
  }
  return React.createElement(StatusBadge, {
    status,
    label: providerModelAvailabilityLabel(availability),
    title
  });
}

export function ProviderModelDiscoveryBadge({
  discovery
}: {
  readonly discovery: ProviderModelDiscoveryView;
}): React.JSX.Element {
  let status: StatusBadgeVariant;
  let label: string;
  let title: string;
  switch (discovery.status) {
    case "observed": {
      status = "valid";
      label = `Observed · ${discovery.models.length} models`;
      title = `Current listing from ${discovery.source}, observed ${discovery.observedAt}.`;
      break;
    }
    case "stale": {
      status = "unavailable";
      label = `Stale · ${discovery.models.length} last-known models`;
      title = discovery.reason;
      break;
    }
    case "unavailable": {
      status = "unavailable";
      label = "Unavailable";
      title = discovery.reason;
      break;
    }
    case "not-observed": {
      status = NOT_OBSERVED_STATUS;
      label = "Not observed";
      title = discovery.reason;
      break;
    }
  }
  return React.createElement(StatusBadge, { status, label, title });
}
