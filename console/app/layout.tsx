import "./globals.css";

import type { Metadata } from "next";
import React from "react";

import { AppShell } from "../src/components/layout/AppShell.ts";

export const metadata: Metadata = {
  title: "AutoDev Console",
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
      React.createElement(AppShell, null, children)
    )
  );
}
