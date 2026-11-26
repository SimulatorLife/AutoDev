import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { SkillDetailView } from "../../../src/features/skills/SkillDetailView.ts";
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
  params
}: {
  readonly params: Promise<{ readonly name: string }>;
}): Promise<React.JSX.Element> {
  const { name } = await params;
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

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(SkillDetailView, {
      source: result.data,
      scopedSkill
    })
  );
}
