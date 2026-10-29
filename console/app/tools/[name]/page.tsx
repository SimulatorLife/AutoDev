import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { filterToolCatalogUsage } from "../../../src/features/tools/tool-usage.ts";
import { ToolDetailView } from "../../../src/features/tools/ToolDetailView.ts";
import {
  catalogueDetailOutcome,
  type CatalogueObservation
} from "../../../src/lib/server/catalogue-detail.ts";
import {
  controlApiFailureCode,
  fetchTools
} from "../../../src/lib/server/control-api.ts";
import { loadOpenLITUsage } from "../../../src/lib/server/openlit-usage.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.ts";

export const dynamic = "force-dynamic";

interface ToolDetailSearchParams {
  readonly range?: string | string[] | undefined;
  readonly startDate?: string | string[] | undefined;
  readonly endDate?: string | string[] | undefined;
  /** The list's narrowing, carried here so the breadcrumb can go back to it. */
  readonly source?: string | string[] | undefined;
  readonly role?: string | string[] | undefined;
  readonly q?: string | string[] | undefined;
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * How the tool catalogue was read.
 *
 * The catalogue is a composite of two independent reads -- the RuleSync tool
 * declarations and the execution contract's role projection -- and the two
 * are observed separately. The catalogue can therefore only say a tool is
 * absent when both were read: a tool the RuleSync source alone declares is
 * missing from a catalogue whose contract half nobody read, and a tool the
 * contract alone projects is missing from one whose RuleSync half was not
 * read.
 */
function toolCatalogueObservation(
  validity: "valid" | "invalid" | "not-observed",
  executionContractObserved: boolean
): CatalogueObservation {
  if (validity === "invalid") {
    return { kind: "invalid", reason: null };
  }
  if (validity === "not-observed") {
    return {
      kind: "not-observed",
      reason:
        "The RuleSync tool declaration was not observed, so the catalogue's contents could not be read."
    };
  }
  if (!executionContractObserved) {
    return {
      kind: "not-observed",
      reason:
        "The execution contract was not read, so the catalogue's role projection could not be read."
    };
  }
  return { kind: "observed" };
}

/**
 * The resource's own name, taken from the route parameter rather than from a
 * second fetch of the resource. The page body already reads the same
 * parameter, and a metadata function that fetched would double every
 * detail-page request.
 */
export async function generateMetadata({
  params
}: {
  readonly params: Promise<{ readonly name: string }>;
}): Promise<Metadata> {
  const { name: raw } = await params;
  const name = decodeURIComponent(raw);
  return { title: `${name} · Tools` };
}

export default async function ToolDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly name: string }>;
  readonly searchParams?: Promise<ToolDetailSearchParams>;
}): Promise<React.JSX.Element> {
  const [{ name: rawName }, sp] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({} as ToolDetailSearchParams)
  ]);
  const decoded = decodeURIComponent(rawName);
  const { section, config } = readNodeContext("/tools");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("tool catalog data")
    );
  }

  const [result, usageResult] = await Promise.all([
    fetchTools(config),
    loadOpenLITUsage({
      range: "24H",
      values: {},
      customRange: {
        startDate: first(sp.startDate),
        endDate: first(sp.endDate)
      }
    })
  ]);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Tool details could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }

  const tool = result.data.tools.find(
    (entry) =>
      entry.name === decoded ||
      `mcp__${entry.server ?? ""}__${entry.name}` === decoded ||
      `${entry.source}:${entry.server ?? ""}:${entry.name}` === decoded
  );
  // A tool the catalogue does not hold has no page -- but only when the
  // catalogue was fully read. It is built from two independent reads, and a
  // catalogue whose RuleSync half or whose contract half was not observed
  // holds the entries that did arrive and says nothing about the rest, so a
  // tool that is not among them may well be there. That answers "this tool
  // could not be read", with the reason, rather than "this tool does not
  // exist", which is a claim nobody made.
  const outcome = catalogueDetailOutcome({
    subject: "Tool",
    source: "tool catalogue",
    invalidCode: "autodev_console_tools_catalogue_invalid",
    unobservedCode: "autodev_console_tools_catalogue_not_observed",
    observation: toolCatalogueObservation(
      result.data.validity,
      result.data.executionContractObserved
    )
  });
  if (!tool && outcome.kind === "unavailable") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: outcome.title,
        code: outcome.code,
        message: outcome.message
      })
    );
  }
  if (!tool) notFound();

  const usage =
    usageResult.kind === "ok"
      ? filterToolCatalogUsage(usageResult.data, tool)
      : { calls: null, errors: null, observed: false };

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(ToolDetailView, {
      tool,
      coverage: result.data.coverage,
      validity: result.data.validity,
      executionContractObserved: result.data.executionContractObserved,
      usage,
      usageLink: result.data.usageLink,
      usageUnavailable:
        usageResult.kind !== "ok" && usageResult.kind !== "not-configured",
      // The list the operator came from. The detail route is a path, so the
      // narrowing travels beside it as a query and the breadcrumb returns
      // them to the list they were reading.
      listFilters: {
        source: first(sp.source),
        role: first(sp.role),
        query: first(sp.q)
      }
    })
  );
}
