import { OpenLITUsageClient } from "./openlit-usage-client.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
// Use a bounded historical date window so ClickHouse partition/primary-key
// pruning validates every v5 widget, filter-option, and trace-list query
// contract without scanning the full 24-hour live telemetry volume on every
// Console service restart.
const CONTRACT_PROBE_DATE = "2000-01-01";

/**
 * What the deployed Usage API answered with.
 *
 * `unreachable` is the class that matters to a supervisor: the API did not
 * answer at all, which is a backend that has not come up yet rather than a
 * contract that is wrong. The Data layer owns the contract and reports the
 * class; the Runtime owns what each class means for a supervised service.
 */
export type UsageContractOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "invalid-response" }
  | { readonly kind: "unauthorized"; readonly status: number }
  | { readonly kind: "http-error"; readonly status: number }
  | { readonly kind: "unreachable" }
  | { readonly kind: "not-configured" };

export interface UsageContractOptions {
  readonly baseUrl?: string;
  readonly serviceToken?: string;
}

/** Verify the deployed Usage response against the v5 contract. */
export async function verifyUsageContract(
  options: UsageContractOptions = {}
): Promise<UsageContractOutcome> {
  const serviceToken =
    options.serviceToken ?? process.env.AUTODEV_OPENLIT_USAGE_TOKEN?.trim();
  if (!serviceToken) return { kind: "not-configured" };

  const client = new OpenLITUsageClient({
    baseUrl:
      options.baseUrl ??
      process.env.AUTODEV_OPENLIT_USAGE_URL?.trim() ??
      DEFAULT_BASE_URL,
    serviceToken
  });
  const result = await client.query({
    range: "CUSTOM",
    customRange: {
      startDate: CONTRACT_PROBE_DATE,
      endDate: CONTRACT_PROBE_DATE
    },
    values: {}
  });

  switch (result.kind) {
    case "ok": {
      return { kind: "ok" };
    }
    case "invalid-response": {
      return { kind: "invalid-response" };
    }
    case "unauthorized": {
      return { kind: "unauthorized", status: result.status };
    }
    case "http-error": {
      return { kind: "http-error", status: result.status };
    }
    case "unreachable": {
      return { kind: "unreachable" };
    }
    default: {
      return { kind: "unreachable" };
    }
  }
}
