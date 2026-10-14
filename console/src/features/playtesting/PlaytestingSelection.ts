"use client";

/**
 * Client host for bounded multi-session analyst-packet selection.
 *
 * The selection is address state written through the History API, so a shared
 * link, a refresh and Back all reproduce the same sessions. Every status
 * rendered here comes from the Runtime owner's answer.
 */
import React, { useCallback, useEffect, useState } from "react";

import {
  parsePlaytestingScope,
  type PlaytestingScope
} from "./playtesting-url.ts";
import { PlaytestingSelectionPanel } from "./PlaytestingSelectionPanel.ts";

function readSelectionFromUrl(): {
  readonly episodeIds: string[];
  readonly rejected: boolean;
} {
  const params = new URLSearchParams(globalThis.location.search);
  const selection = parsePlaytestingScope({
    ...(params.has("view") ? { view: params.get("view") ?? "" } : {}),
    ...(params.has("workspaceId")
      ? { workspaceId: params.get("workspaceId") ?? "" }
      : {}),
    ...(params.has("sessions") ? { sessions: params.getAll("sessions") } : {})
  });
  return {
    episodeIds: [...selection.selectedEpisodeIds],
    rejected: selection.invalidSelection
  };
}

export interface PlaytestingSelectionProps {
  readonly scope: PlaytestingScope;
  readonly initialSelectedEpisodeIds: readonly string[];
  readonly selectableEpisodeIds: readonly string[];
}

export function PlaytestingSelection({
  scope,
  initialSelectedEpisodeIds,
  selectableEpisodeIds
}: PlaytestingSelectionProps): React.JSX.Element {
  const [selected, setSelected] = useState<readonly string[]>(
    initialSelectedEpisodeIds
  );
  const [rejectedSelection, setRejectedSelection] = useState(
    scope.invalidSelection
  );

  const changeSelection = useCallback((episodeIds: readonly string[]) => {
    setSelected(episodeIds);
    setRejectedSelection(false);
    const url = new URL(globalThis.location.href);
    if (episodeIds.length === 0) url.searchParams.delete("sessions");
    else url.searchParams.set("sessions", episodeIds.join(","));
    globalThis.history.pushState(null, "", url);
  }, []);

  useEffect(() => {
    const onPopState = (): void => {
      const selection = readSelectionFromUrl();
      setSelected(selection.episodeIds);
      setRejectedSelection(selection.rejected);
    };
    globalThis.addEventListener("popstate", onPopState);
    return () => globalThis.removeEventListener("popstate", onPopState);
  }, []);

  return React.createElement(PlaytestingSelectionPanel, {
    scope,
    selectableEpisodeIds,
    selectedEpisodeIds: selected,
    rejectedSelection,
    onSelectionChange: changeSelection
  });
}
