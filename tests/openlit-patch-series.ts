/**
 * The maintained OpenLIT patch series, in apply order, and the one rule that
 * decides whether a directory listing *is* that series.
 *
 * This lives outside the applying test on purpose. The OpenLIT fork boundary is
 * maintained by replaying this series (patches 01..N) over the pinned upstream
 * commit, so "is the series still exactly what we maintain, in order?" is an
 * invariant about the repository, not about any one clone-requiring test. Keeping
 * the names here means a cheap test can check the invariant against the files on
 * disk without running `git clone`, and it gives the applying test and every
 * other caller a single owner instead of a list each.
 */

import assert from "node:assert/strict";

/** Every patch in the maintained OpenLIT series, in apply order. */
export const OPENLIT_PATCH_NAMES = [
  "01-generic-dashboard-variables",
  "02-autodev-pages",
  "03-otlp-receiver-auth",
  "04-autodev-usage-dashboard",
  "05-remove-login-signup",
  "06-autodev-branding",
  "07-autodev-usage-api",
  "08-autodev-memory-connector",
  "09-autodev-memory-lifecycle-actions",
  "10-autodev-memory-action-hardening",
  "11-autodev-memory-lifecycle-ui",
  "12-autodev-memory-outcomes",
  "13-autodev-memory-outcome-cohorts",
  "14-autodev-memory-outcome-reporting",
  "15-remove-gpu-product",
  "16-autodev-memory-session-outcome-cohorts",
  "17-remove-openlit-memory-session-authorization",
  "18-remove-openlit-controller-discovery",
  "19-remove-controller-image-runtime",
  "20-remove-stale-controller-messages",
  "21-remove-controller-clickhouse-schema",
  "22-autodev-memory-injection-use",
  "23-autodev-memory-visible-connector",
  "24-autodev-pricing-empty-history",
  "25-autodev-usage-filter-options",
  "26-autodev-usage-trace-detail",
  "27-remove-otter-chat-docs-onboarding-chrome",
  "28-remove-autodev-pages",
  "29-remove-openground",
  "30-remove-rule-engine",
  "31-remove-theme-switching-and-marketing-404",
  "32-remove-organisations-projects-environments",
  "33-remove-dashboard-authoring",
  "34-remove-board-authoring-tables",
  "35-remove-vault-administration",
  "36-dead-surfaces-and-broken-sidebar-nav",
  "37-remove-duplicate-agents-shell",
  "38-remove-docs-and-account-surfaces",
  "39-remove-database-config-sharing",
  "40-single-user-model-auth-and-honest-empty-state",
  "41-remove-rule-engine-ui-trace",
  "42-remove-dead-agents-navigation",
  "43-remove-tenancy-route-residue",
  "44-remove-removed-product-route-residue",
  "45-honest-signal-detail-states",
  "46-metric-detail-honest-empty-state",
  "47-currency-rounding-formatting",
  "48-stat-card-honest-empty-state",
  "49-analytics-ungate-ping-gate",
  "50-ungate-the-remaining-telemetry-reads",
  "51-format-chart-time-axis-ticks",
  "52-request-time-telemetry-rendering",
  "53-batch-auto-pricing-mutations"
] as const;

/** Strips the `.patch` suffix a directory listing carries. */
export function patchNames(files: readonly string[]): string[] {
  return files.map((file) => file.replace(/\.patch$/u, ""));
}

/**
 * Assert a listing of patch files is exactly the maintained series, in order.
 *
 * Data-driven rather than one check per patch: the ladder this replaced grew the
 * caller past the cognitive-complexity ceiling. Exact equality is also stronger
 * than a prefix walk -- an unexpected, missing, renamed or reordered patch fails
 * instead of being quietly skipped, which is what a hand-maintained per-patch
 * list silently stopped doing once the series outgrew it.
 *
 * A checkout that predates the newest patches still passes: the expected series
 * is intersected with what is actually present, which is the tolerance the old
 * per-patch `if (patches.some((p) => p.startsWith("NN-")))` conditionals
 * provided by hand.
 */
export function assertOpenlitPatchSeries(files: readonly string[]): string[] {
  const applied = patchNames(files);
  const expected = OPENLIT_PATCH_NAMES.filter((name) => applied.includes(name));
  assert.deepEqual(
    applied,
    expected,
    `the OpenLIT patch series must be exactly the known patches, in order; on disk: ${applied.join(", ")}`
  );
  return expected;
}
