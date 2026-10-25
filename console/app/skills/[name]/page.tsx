import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import {
  skillContentSaveOutcome,
  SkillDetailView
} from "../../../src/features/skills/SkillDetailView.ts";
import { editorBaseRevisionFromQuery } from "../../../src/lib/server/canonical-source.ts";
import {
  controlApiFailureCode,
  fetchSkillContent,
  fetchSkills
} from "../../../src/lib/server/control-api.ts";
import { skillsFromControlApi } from "../../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params
}: {
  readonly params: Promise<{ readonly name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Skills` };
}

export default async function SkillDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly name: string }>;
  readonly searchParams?: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const [{ name }, query] = await Promise.all([
    params,
    searchParams ??
      Promise.resolve(
        {} as Record<string, string | readonly string[] | undefined>
      )
  ]);
  const { section, config } = readNodeContext("/skills");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("canonical skill content")
    );
  }

  // The content and the catalogue are two different facts: the content is the
  // canonical source, and the catalogue says where the skill is installed. A
  // catalogue that cannot be read leaves the scope unobserved rather than
  // making the skill look installed nowhere.
  const [result, catalogue] = await Promise.all([
    fetchSkillContent(name, config),
    fetchSkills(config)
  ]);
  if (result.kind === "http-error" && result.status === 404) notFound();
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Skill source could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }
  const scopedSkill =
    catalogue.kind === "ok"
      ? (skillsFromControlApi(catalogue.data).find(
          (skill) => skill.name === name
        ) ?? null)
      : null;

  const saveOutcome = skillContentSaveOutcome(query.save);
  // The editor writes against the revision its content is based on. A refused
  // write leaves the browser holding the operator's edit, so the page keeps
  // the revision that edit was written for rather than the revision the
  // source has moved to.
  const editorRevision =
    editorBaseRevisionFromQuery(query.based) ?? result.data.revision;
  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(SkillDetailView, {
      source: result.data,
      editorRevision,
      scopedSkill,
      ...(saveOutcome ? { saveOutcome } : {})
    })
  );
}
