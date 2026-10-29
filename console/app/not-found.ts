import type { Metadata } from "next";
import React from "react";

import { ConsoleNotFoundShell } from "../src/components/layout/AppShell.ts";

/**
 * The title of the page a bad address lands on.
 *
 * The root layout's default title is the product's name, which is what every
 * route that declares no title of its own gets. A page that exists only to
 * say that the address was wrong should say so in the tab as well: the
 * operator who follows a stale link sees "AutoDev Console" in the tab and
 * has to read the page to learn that nothing was found.
 */
export const metadata: Metadata = {
  title: "Page not found"
};

export default function NotFound(): React.JSX.Element {
  return React.createElement(ConsoleNotFoundShell);
}
