import "./globals.css";

import type { Metadata } from "next";
import React from "react";

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
      children
    )
  );
}
