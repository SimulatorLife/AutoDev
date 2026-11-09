import type { ControlApiProviderVersionsResponse } from "@simulatorlife/autodev-core";

import { NOT_OBSERVED_STATUS } from "../../components/status/StatusBadge.ts";

/**
 * The CLI versions as the Console received them.
 *
 * The response is separate from the provider record, so this state keeps the
 * two apart: the providers page is readable even when the versions did not
 * arrive, and the version cell says it was not observed instead of the page
 * failing over a release number.
 */
export type ProviderCliVersionState =
  | {
      readonly status: "available";
      readonly data: ControlApiProviderVersionsResponse;
    }
  | { readonly status: "unavailable"; readonly message: string };

/**
 * One provider's CLI version, in the terms the page renders.
 *
 * "Not observed" means the Runtime did not report this provider's version at
 * all. "Not installed" means the CLI is not on this machine, and "Not read"
 * means it is there but would not answer. They are three different
 * situations, and an operator fixes them three different ways.
 */
export type ProviderCliVersionView =
  | {
      readonly status: "observed";
      readonly command: string;
      readonly version: string;
      readonly observedAt: string;
    }
  | {
      readonly status: "not-installed";
      readonly command: string | null;
      readonly reason: string;
    }
  | {
      readonly status: "not-readable";
      readonly command: string | null;
      readonly reason: string;
    }
  | { readonly status: typeof NOT_OBSERVED_STATUS; readonly reason: string };

/**
 * The state of a caller that has not read the versions.
 *
 * The rows then say the version was not observed, which is the truth: a
 * version nobody read is not a version of zero, and it is not a version the
 * page may invent.
 */
export const CLI_VERSIONS_NOT_OBSERVED: ProviderCliVersionState = {
  status: "unavailable",
  message: "Provider CLI versions were not read."
};

/** The version this provider's CLI is on, as the page shows it. */
export function providerCliVersionView(
  state: ProviderCliVersionState,
  provider: string
): ProviderCliVersionView {
  if (state.status === "unavailable") {
    return { status: NOT_OBSERVED_STATUS, reason: state.message };
  }
  const entry = state.data.providers.find(
    (candidate) => candidate.provider === provider
  );
  if (entry === undefined) {
    return {
      status: NOT_OBSERVED_STATUS,
      reason: "Runtime did not report a CLI version for this provider."
    };
  }
  const cli = entry.cli;
  if (cli.status === "observed") {
    return {
      status: "observed",
      command: cli.command,
      version: cli.version,
      observedAt: cli.observedAt
    };
  }
  if (cli.kind === "not-installed") {
    return {
      status: "not-installed",
      command: cli.command,
      reason: cli.reason
    };
  }
  return { status: "not-readable", command: cli.command, reason: cli.reason };
}

/**
 * The version as one label: the CLI's name and the release it reported.
 *
 * The CLI's name is part of the label because the number alone does not say
 * which program it belongs to, and two providers can be served by the same
 * CLI.
 */
export function providerCliVersionLabel(view: ProviderCliVersionView): string {
  switch (view.status) {
    case "observed": {
      return `${view.command} ${view.version}`;
    }
    case "not-installed": {
      return view.command === null
        ? "Not installed"
        : `${view.command} · Not installed`;
    }
    case "not-readable": {
      return view.command === null ? "Not read" : `${view.command} · Not read`;
    }
    case NOT_OBSERVED_STATUS: {
      return "Not observed";
    }
    default: {
      throw new TypeError("Provider CLI version state is invalid.");
    }
  }
}
