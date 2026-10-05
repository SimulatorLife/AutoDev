"use client";

import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import { usePathname } from "next/navigation.js";
import React from "react";

import { canonicalSectionFromPath } from "../../lib/routes.ts";
import { AppNav } from "./AppNav.ts";

/**
 * Canonical section owning the current route. The persistent shell lives in
 * the root layout, which the App Router does not re-render on client-side
 * navigation, so the active section is derived from the live pathname rather
 * than threaded through every page.
 */
export function useActiveSection(): CanonicalNavSection | null {
  return canonicalSectionFromPath(usePathname() ?? "/");
}

/** Sidebar navigation highlighting the section that owns the current route. */
export function ActiveAppNav(): React.JSX.Element {
  return React.createElement(AppNav, { activeSection: useActiveSection() });
}

/** Shell header title naming the section that owns the current route. */
export function ActiveSectionHeading(): React.JSX.Element | null {
  const section = useActiveSection();
  return section
    ? React.createElement(
        "h1",
        { className: "text-lg font-bold text-fg" },
        section
      )
    : null;
}
