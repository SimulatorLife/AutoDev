/**
 * The Providers surfaces' Control API read set.
 *
 * Server-only. The list, provider detail, and model detail pages all read the
 * same Control API projections, and they read them as one fan-out -- several
 * requests that the Control API answers together, on one host, while that host
 * is busy with whatever else the operator is running.
 *
 * The fan-out is owned here so the budget that fits it is owned with it.
 *
 * The generic 5-second Control API deadline in `src/lib/server/control-api.ts`
 * was measured against a single read. Measured against the live Control API
 * on a loaded host, the Providers fan-out drains in 2.6-7.2 seconds, and the
 * Console reported that as `autodev_control_api_timeout` -- "The AutoDev
 * Control API did not answer within 5s" -- for a Control API that had
 * answered every request. A read that is merely slow is not a service that is
 * down, and the Console already draws that distinction elsewhere; what it was
 * missing here was a budget that matches the fan-out the page actually issues.
 *
 * The GitHub projection and the playtesting reads already carry their own
 * budgets for the same reason (`GITHUB_CONTROL_API_TIMEOUT_MS`,
 * `PLAYTESTING_CONTROL_API_TIMEOUT_MS`). The Providers surfaces are the third
 * read set of that shape, and they had none.
 */

import {
  type ControlApiModelsResponse,
  type ControlApiProviderModelsResponse,
  type ControlApiProvidersResponse,
  type ControlApiProviderVersionsResponse,
  type ControlApiRuntimeResponse
} from "@simulatorlife/autodev-core";

import {
  type ControlApiConfig,
  type ControlApiResult,
  type FetchControlApiOptions,
  fetchModels,
  fetchProviderModelDiscovery,
  fetchProviders,
  fetchProviderVersions,
  fetchRuntime
} from "../../src/lib/server/control-api.ts";

/**
 * The Providers surfaces' Control API deadline.
 *
 * The fan-out is several requests that the Control API answers together. The
 * budget covers that fan-out draining on a loaded host, with room for the
 * Control API to answer them in the order it chooses.
 */
export const PROVIDERS_CONTROL_API_TIMEOUT_MS = 20_000;

/**
 * What one Providers surface reads.
 *
 * A surface that does not read a projection is not answered for it: `null`
 * means the surface never asked, which is a different fact from a read that
 * was asked and failed.
 */
export interface ProvidersSurfaceReads {
  readonly providers: ControlApiResult<ControlApiProvidersResponse>;
  readonly models: ControlApiResult<ControlApiModelsResponse> | null;
  readonly modelDiscovery: ControlApiResult<ControlApiProviderModelsResponse>;
  readonly providerVersions: ControlApiResult<ControlApiProviderVersionsResponse> | null;
  readonly runtime: ControlApiResult<ControlApiRuntimeResponse>;
}

/** The reads of a surface that asked for the model catalog. */
export interface ProvidersSurfaceReadsWithModels extends ProvidersSurfaceReads {
  readonly models: ControlApiResult<ControlApiModelsResponse>;
}

/** The reads of a surface that asked for the provider CLI versions. */
export interface ProvidersSurfaceReadsWithVersions extends ProvidersSurfaceReads {
  readonly providerVersions: ControlApiResult<ControlApiProviderVersionsResponse>;
}

/**
 * The reads of a surface that asked for the model catalog and the provider
 * CLI versions.
 */
export interface ProvidersSurfaceReadsWithModelsAndVersions
  extends ProvidersSurfaceReadsWithModels {
  readonly providerVersions: ControlApiResult<ControlApiProviderVersionsResponse>;
}

export interface ProvidersSurfaceReadOptions extends FetchControlApiOptions {
  /**
   * Whether this surface reads the model catalog.
   *
   * The list page reads it only on the Models tab; the detail pages read it
   * because they show which of a provider's models are available.
   */
  readonly includeModels?: boolean;
  /**
   * Whether this surface reads the provider CLI versions.
   *
   * A Runtime that does not publish them still answers the providers
   * contract, so a missing version is reported in the rows rather than
   * failing the page -- but only the surfaces that show them ask.
   */
  readonly includeProviderVersions?: boolean;
}

/**
 * The Providers surfaces' Control API reads, as one fan-out.
 *
 * Every read carries the Providers budget, so a surface cannot be assembled
 * from reads with the generic deadline by accident: the budget travels with
 * the fan-out rather than with each call site. A caller that states its own
 * deadline still wins -- the budget is this surface's default, not a rule it
 * imposes on a caller that knows better.
 */
export async function readProvidersSurface(
  config: ControlApiConfig,
  options: ProvidersSurfaceReadOptions & {
    readonly includeModels: true;
    readonly includeProviderVersions: true;
  }
): Promise<ProvidersSurfaceReadsWithModelsAndVersions>;
export async function readProvidersSurface(
  config: ControlApiConfig,
  options: ProvidersSurfaceReadOptions & { readonly includeModels: true }
): Promise<ProvidersSurfaceReadsWithModels>;
export async function readProvidersSurface(
  config: ControlApiConfig,
  options: ProvidersSurfaceReadOptions & {
    readonly includeProviderVersions: true;
  }
): Promise<ProvidersSurfaceReadsWithVersions>;
export async function readProvidersSurface(
  config: ControlApiConfig,
  options?: ProvidersSurfaceReadOptions
): Promise<ProvidersSurfaceReads>;
export async function readProvidersSurface(
  config: ControlApiConfig,
  options: ProvidersSurfaceReadOptions = {}
): Promise<ProvidersSurfaceReads> {
  const budget: FetchControlApiOptions = {
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
    timeoutMs: options.timeoutMs ?? PROVIDERS_CONTROL_API_TIMEOUT_MS
  };
  const [
    providers,
    models,
    modelDiscovery,
    providerVersions,
    runtime
  ] = await Promise.all([
    fetchProviders(config, budget),
    options.includeModels === true
      ? fetchModels(config, budget)
      : Promise.resolve(null),
    fetchProviderModelDiscovery(config, budget),
    options.includeProviderVersions === true
      ? fetchProviderVersions(config, budget)
      : Promise.resolve(null),
    fetchRuntime(config, budget)
  ]);
  return {
    providers,
    models,
    modelDiscovery,
    providerVersions,
    runtime
  };
}
