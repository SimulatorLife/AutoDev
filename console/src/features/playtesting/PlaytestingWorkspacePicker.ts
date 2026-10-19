"use client";

import type { WorkspaceEntry } from "@simulatorlife/autodev-core";
import { useRouter } from "next/navigation";
import React from "react";

import { SelectField } from "../../components/forms/SelectField.ts";
import {
  playtestingListHref,
  type PlaytestingScope
} from "./playtesting-url.ts";

export function PlaytestingWorkspacePicker({
  scope,
  workspaces
}: {
  readonly scope: PlaytestingScope;
  readonly workspaces: readonly WorkspaceEntry[];
}): React.JSX.Element {
  const router = useRouter();
  return React.createElement(SelectField, {
    name: "workspaceId",
    label: "Workspace",
    defaultValue: scope.workspaceId ?? "",
    options: [
      { value: "", label: "Choose a workspace" },
      ...workspaces.map((workspace) => ({
        value: workspace.id,
        label: workspace.id + (workspace.enabled ? "" : " · disabled")
      }))
    ],
    className: "min-w-56",
    onChange: (event) => {
      const workspaceId = event.currentTarget.value || null;
      router.push(
        playtestingListHref({
          ...scope,
          workspaceId,
          filters: {},
          cursor: null,
          step: null,
          liveBatchId: null,
          selectedEpisodeIds: [],
          returnFindingId: null,
          invalidQuery: false,
          invalidSelection: false
        })
      );
    }
  });
}
