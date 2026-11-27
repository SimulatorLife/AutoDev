"use client";

import React from "react";

import { ConsoleErrorShell } from "../src/components/layout/AppShell.ts";

export default function ErrorBoundary(properties: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): React.JSX.Element {
  return React.createElement(ConsoleErrorShell, properties);
}
