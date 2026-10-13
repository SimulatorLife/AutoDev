"use client";

/**
 * Client host for multi-session analysis selection.
 *
 * The selection is address state written through the History API, so a shared
 * link, a refresh and Back all reproduce the same sessions. Every status
 * rendered here comes from the Runtime owner's answer.
 */
import React, { useCallback, useEffect, useState } from "react";

import { PlaytestingSelectionPanel } from "./PlaytestingSelectionPanel.ts";

function readSelectionFromUrl(): string[] {
  const raw = new URLSearchParams(window.location.search).get("sessions");
  if (raw === null) return [];
  return raw.split(",").filter((part) => part.length > 0);
}

export interface PlaytestingSelectionProps {
  readonly workspaceId: string;
  readonly initialSelectedEpisodeIds: readonly string[];
  readonly selectableEpisodeIds: readonly string[];
}

export function PlaytestingSelection({
  workspaceId,
  initialSelectedEpisodeIds,
  selectableEpisodeIds
}: PlaytestingSelectionProps): React.JSX.Element {
  const [selected, setSelected] = useState<readonly string[]>(
    initialSelectedEpisodeIds
  );

  const changeSelection = useCallback((episodeIds: readonly string[]) => {
    setSelected(episodeIds);
    const url = new URL(window.location.href);
    if (episodeIds.length === 0) url.searchParams.delete("sessions");
    else url.searchParams.set("sessions", episodeIds.join(","));
    window.history.pushState(null, "", url);
  }, []);

  useEffect(() => {
    const onPopState = (): void => {
      setSelected(readSelectionFromUrl());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return React.createElement(PlaytestingSelectionPanel, {
    workspaceId,
    selectableEpisodeIds,
    selectedEpisodeIds: selected,
    onSelectionChange: changeSelection
  });
}