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
import { type ProviderUsageReading, providerUsagePath } from "./provider-usage.ts";

const PROVIDER_USAGE_COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});

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
  const status =
    reading.status === "observed"
      ? "valid"
      : reading.status === NOT_OBSERVED_STATUS
        ? NOT_OBSERVED_STATUS
        : reading.status === "pending"
          ? "pending"
          : "unavailable";
  const label =
    reading.status === "observed"
      ? "Observed"
      : reading.status === NOT_OBSERVED_STATUS
        ? "Not observed"
        : reading.status === "pending"
          ? "Pending"
          : reading.status === "not-configured"
            ? "Not configured"
            : "Unavailable";
  let evidence: React.ReactNode;
  if (reading.status === "observed") {
    evidence = React.createElement(
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
  } else if (reading.status === "pending") {
    evidence = React.createElement(
      "p",
      {
        className: MUTED_BODY_CLASS,
        "data-provider-usage-message": true,
        "aria-busy": "true"
      },
      "The Usage telemetry read has not answered yet; provider-attempt counts are not rendered as zero."
    );
  } else {
    evidence = React.createElement(
      "p",
      { className: MUTED_BODY_CLASS, "data-provider-usage-message": true },
      reading.status === "not-configured"
        ? "Usage telemetry credentials are not configured; provider-attempt counts are unavailable."
        : reading.status === NOT_OBSERVED_STATUS
          ? "Provider-attempt telemetry was not observed in the last 7 days."
          : "Usage telemetry could not be read; provider-attempt counts remain unavailable."
    );
  }

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
