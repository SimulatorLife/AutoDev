import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { hookSaveOutcomeFromQuery } from "../../../src/features/hooks/declaration.ts";
import { HookEventDetailView } from "../../../src/features/hooks/HookEventDetailView.ts";
import { editorBaseRevisionFromQuery } from "../../../src/lib/server/canonical-source.ts";
import {
  catalogueDetailOutcome,
  catalogueObservation
} from "../../../src/lib/server/catalogue-detail.ts";
import {
  controlApiFailureCode,
  fetchHooks,
  fetchHooksApplied
} from "../../../src/lib/server/control-api.ts";
import { hooksFromControlApi } from "../../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.ts";

export const dynamic = "force-dynamic";

/**
 * The resource's own name, taken from the route parameter rather than from a
 * second fetch of the resource. The page body already reads the same
 * parameter, and a metadata function that fetched would double every
 * detail-page request.
 */
export async function generateMetadata({
  params
}: {
  readonly params: Promise<{ readonly event: string }>;
}): Promise<Metadata> {
  const { event } = await params;
  return { title: `${event} · Hooks` };
}

export default async function HookEventDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly event: string }>;
  readonly searchParams?: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const [{ event }, resolvedSearchParams] = await Promise.all([
    params,
    searchParams ??
      Promise.resolve(
        {} as Record<string, string | readonly string[] | undefined>
      )
  ]);
  const { section, config } = readNodeContext("/hooks");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("hook configuration")
    );
  }

  // The declaration and the projection are two reads that answer two
  // questions, and the page composes them.
  const [result, appliedResult] = await Promise.all([
    fetchHooks(config),
    fetchHooksApplied(config)
  ]);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Hook event could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }

  const hooks = hooksFromControlApi(result.data);
  const hook = hooks.find((entry) => entry.event === event);
  // An event the target does not declare has no page. The Runtime publishes
  // the effective declaration for the target -- the shared one with the
  // target's own over it -- so an event that is not in it is not declared for
  // this target, and there is nothing here to edit.
  //
  // The answer is the not-found shell rather than a 404 status: the layout's
  // boundary flushes the shell before the page resolves, so the status is
  // already committed by the time this page knows the event is absent. Every
  // detail route answers a missing item the same way.
  //
  // But "the declaration does not hold this event" is only a fact when the
  // declaration was read. An invalid declaration publishes no events because
  // it could not be applied, and an unobserved one publishes none because
  // nothing about it was read -- and an event that was there a moment ago is
  // still there. Both answer "this event could not be read", with the reason,
  // rather than "this event does not exist", which is a claim nobody made.
  const outcome = catalogueDetailOutcome({
    subject: "Hook event",
    source: "canonical hook declaration",
    invalidCode: "autodev_console_hooks_catalogue_invalid",
    unobservedCode: "autodev_console_hooks_catalogue_not_observed",
    observation: catalogueObservation(result.data.valid, result.data.issues)
  });
  if (!hook && outcome.kind === "unavailable") {
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
  if (!hook) notFound();

  // An unreadable applied read is not an applied configuration with nothing in
  // it, and the page says which of the two it is.
  const applied = appliedResult.kind === "ok" ? appliedResult.data : null;
  const appliedUnavailable =
    appliedResult.kind === "ok"
      ? null
      : {
          code: controlApiFailureCode(appliedResult),
          message: appliedResult.message
        };

  // The editor writes against the revision its content is based on. A refused
  // write leaves the browser holding the operator's edit, so the page keeps
  // the revision that edit was written for rather than the revision the
  // declaration has moved to.
  const basedOn = editorBaseRevisionFromQuery(resolvedSearchParams.based);
  const saveOutcome = hookSaveOutcomeFromQuery(resolvedSearchParams.save);

  return React.createElement(
    ConsolePageShell,
    {
      section,
      // The badge counts the declared events, and it is a count only when the
      // declaration was read. An invalid or unreadable declaration publishes
      // an empty list, and a badge with that list's length would claim the
      // target declares no hooks -- a claim about the read, not about the
      // target. The list page draws the badge the same way.
      ...(result.data.valid === true ? { counts: { Hooks: hooks.length } } : {})
    },
    React.createElement(HookEventDetailView, {
      hook,
      source: result.data.source,
      sourceValidity: result.data.valid,
      revision: result.data.revision,
      ...(basedOn === undefined ? {} : { editorRevision: basedOn }),
      applied,
      ...(appliedUnavailable === null ? {} : { appliedUnavailable }),
      ...(saveOutcome === undefined ? {} : { saveOutcome })
    })
  );
}
