import "./globals.css";

import type { Metadata } from "next";
import React from "react";

import { ConsoleLoadingShell } from "../src/components/layout/AppShell.ts";
import { FormNavigationOwner } from "../src/components/navigation/FormNavigationOwner.ts";

export const metadata: Metadata = {
  // `template` is what makes the per-route titles worth declaring: a route
  // says "worker · Agents" and the product name is appended here rather than
  // retyped in nineteen route files. `default` covers the one route that
  // declares no title of its own.
  title: {
    default: "AutoDev Console",
    template: "%s · AutoDev Console"
  },
  description: "AutoDev single-user control and observability console.",
  applicationName: "AutoDev Console",
  robots: { index: false, follow: false }
};

/**
 * The Console's root layout, and the owner of the pending state a page shows
 * while its server-owned read is on its way.
 *
 * A page awaits its own read, so the page's model and the content that read
 * confirmed arrive as one answer, and an in-place navigation has a complete
 * page to apply.
 *
 * The pending state belongs to the layout, and that is not a matter of taste.
 * A boundary inside a route segment -- a `loading.tsx`, or a `<Suspense>` a
 * page wraps its own content in -- splits that segment's answer in two: the
 * segment's model resolves before the content it waits for, so the segment a
 * navigation replaces is no longer the segment the browser holds. Next.js
 * answers a navigation to such a route with the shell first and the content
 * after it, and the navigation's commit -- the commit that moves the address
 * bar -- waits for the second half.
 *
 * This boundary is in the layout, and a layout is the one segment an in-place
 * navigation does not replace: the navigation re-sends the page's own segment
 * and leaves the layout's segment, and the boundary inside it, exactly where
 * they were. The page's answer therefore arrives whole, and the address bar and
 * the page move together.
 *
 * The route-level boundary that used to sit at `app/loading.tsx` is gone for
 * the same reason, and Next.js has two more reasons to keep it gone: a route
 * with a `loading.tsx` is prefetched as a shell and its content is fetched
 * again during the navigation, and a navigation to a route with search
 * parameters reuses the parameter-less prefetch of the same route as an alias
 * and fetches the page again. Both of those make the navigation depend on a
 * second round trip, and a second round trip that does not arrive is a
 * navigation whose commit never runs.
 */
export default function RootLayout({
  children
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return React.createElement(
    "html",
    { lang: "en" },
    React.createElement(
      "body",
      {
        className: "bg-background text-fg antialiased"
      },
      React.createElement(
        React.Suspense,
        { fallback: React.createElement(ConsoleLoadingShell) },
        children
      ),
      React.createElement(FormNavigationOwner)
    )
  );
}
