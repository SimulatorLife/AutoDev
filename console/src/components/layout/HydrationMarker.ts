"use client";

import React from "react";

/**
 * The page's own "the client has taken over" marker.
 *
 * The Console's pages are server-rendered, so the markup arrives before the
 * client does. A page that has its content is not yet a page that responds:
 * the palette's shortcut, the filters and the write controls all belong to
 * the client, and a keystroke or a click in the gap between the two goes
 * nowhere. The console answers that gap with its loading state, and the
 * loading state says "the content is not here yet" -- it has no word for
 * "the content is here and the client is not", which is the state the page
 * is in for as long as it takes the bundle to arrive.
 *
 * So the marker publishes it. It is a state rather than a piece of layout: it
 * carries no text, it is not announced, and it exists so that "the content is
 * here" and "the client is here" are two facts a caller can wait for
 * separately rather than one fact it has to infer.
 *
 * It is rendered with the page's own content rather than with the shell,
 * because the shell is also what the pending state is rendered with: a marker
 * the pending state set would report a client that had taken over a page
 * that had not arrived yet.
 *
 * The marker is the last thing in the page's content, so its effect runs
 * after the effects of everything the content is made of. A caller that waits
 * for it is therefore waiting for the page's own controls to be live and not
 * merely for the shell around them.
 */
export function HydrationMarker(): React.JSX.Element {
  const markerRef = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    markerRef.current?.setAttribute("data-hydrated", "true");
  }, []);

  return React.createElement("span", {
    ref: markerRef,
    hidden: true,
    "aria-hidden": true,
    "data-hydration-marker": "true"
  });
}
