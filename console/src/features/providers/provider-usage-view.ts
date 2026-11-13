import type { ControlApiProviderRecord } from "@simulatorlife/autodev-core";
import React from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { DETAIL_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import {
  providerUsagePath,
  type ProviderUsageReading
} from "./provider-usage.ts";

const PROVIDER_USAGE_COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});

function usageBadge(reading: ProviderUsageReading): {
  readonly status: string;
  readonly label: string;
} {
  switch (reading.status) {
    case "observed": {
      return { status: "valid", label: "Observed" };
    }
    case NOT_OBSERVED_STATUS: {
      return { status: NOT_OBSERVED_STATUS, label: "Not observed" };
    }
    case "pending": {
      return { status: "pending", label: "Pending" };
    }
    case "not-configured": {
      return { status: "unavailable", label: "Not configured" };
    }
    default: {
      return { status: "unavailable", label: "Unavailable" };
    }
  }
}

function usageMessage(reading: ProviderUsageReading): string {
  switch (reading.status) {
    case "not-configured": {
      return "Usage telemetry credentials are not configured; provider-attempt counts are unavailable.";
    }
    case NOT_OBSERVED_STATUS: {
      return "Provider-attempt telemetry was not observed in the last 7 days.";
    }
    default: {
      return "Usage telemetry could not be read; provider-attempt counts remain unavailable.";
    }
  }
}

function usageEvidence(reading: ProviderUsageReading): React.ReactNode {
  if (reading.status === "observed") {
    return React.createElement(
      DetailGrid,
      { columns: 2 },
      React.createElement(
        DetailValue,
        { label: "Physical attempts · last 7 days" },
        PROVIDER_USAGE_COUNT_FORMATTER.format(reading.attempts)
      ),
      React.createElement(
        DetailValue,
        { label: "Failed attempts · last 7 days" },
        reading.failures === null
          ? NOT_OBSERVED_LABEL
          : PROVIDER_USAGE_COUNT_FORMATTER.format(reading.failures)
      )
    );
  }
  if (reading.status === "pending") {
    return React.createElement(
      "p",
      {
        className: MUTED_BODY_CLASS,
        "data-provider-usage-message": true,
        "aria-busy": "true"
      },
      "The Usage telemetry read has not answered yet; provider-attempt counts are not rendered as zero."
    );
  }
  return React.createElement(
    "p",
    { className: MUTED_BODY_CLASS, "data-provider-usage-message": true },
    usageMessage(reading)
  );
}

/**
 * The provider's usage panel.
 *
 * The panel renders a reading. It does not read: the reading is fetched in
 * the browser, after the page has rendered, because the seven-day attempt
 * aggregation is the most expensive read the Console makes and it answers a
 * question about one panel rather than about the page.
 *
 * The reading has a state the measurements do not -- the pending state --
 * and it is rendered as its own thing. A panel that is still waiting has not
 * been told that the provider made no attempts, and rendering that absence
 * as a zero is the failure this state exists to prevent.
 */
export function providerUsageView({
  provider,
  reading
}: {
  readonly provider: ControlApiProviderRecord;
  readonly reading: ProviderUsageReading;
}): React.JSX.Element {
  const { status, label } = usageBadge(reading);
  const evidence = usageEvidence(reading);

  return React.createElement(
    "section",
    {
      className: DETAIL_PANEL_CLASS,
      "data-section": "provider-usage",
      "data-provider-usage-status": reading.status
    },
    React.createElement(
      "div",
      { className: "mb-3 flex flex-wrap items-center justify-between gap-3" },
      React.createElement(
        "div",
        { className: "flex flex-wrap items-center gap-2" },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Usage · last 7 days"
        ),
        React.createElement(StatusBadge, { status, label })
      ),
      React.createElement(
        NavigationLink,
        {
          href: providerUsagePath(provider.id),
          className: "text-xs text-accent underline underline-offset-2"
        },
        "Open scoped Usage →"
      )
    ),
    React.createElement(
      "p",
      { className: `mb-3 ${MUTED_META_CLASS}` },
      "Provider attempts are physical attempts. Logical routed requests are not attributed to a single provider."
    ),
    evidence
  );
}
