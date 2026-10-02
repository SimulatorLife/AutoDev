import { type CanonicalNavSection } from "@simulatorlife/autodev-core";
import React from "react";

import { MemoryPortalCard } from "../../src/features/memory/MemoryPortalCard.ts";
import { readMemoryPortalConfig } from "../../src/lib/server/memory-portal.ts";
import { ConsolePageShell, ResourceUnavailable } from "../_console.tsx";

export const dynamic = "force-dynamic";

const SECTION: CanonicalNavSection = "Memory";

/**
 * Memory entry point.
 *
 * The retained, AutoDev-branded Memory operator page is the sole Memory
 * operator UI (lifecycle actions, provenance/history, per-experience
 * outcomes, and the bounded cohort view). This route never reimplements
 * that CRUD/list/detail/cohort UI, never calls the Memory Control API
 * directly, and never embeds the page in an iframe. It renders a small
 * portal/entry card linking to the configured public Memory destination
 * URL (`AUTODEV_OPENLIT_UI_URL`), normalized to the fixed `/memory`
 * path, or an explicit unavailable state when that URL is not configured
 * safely.
 *
 * The route makes no Control API request and never reads or forwards any
 * service token, so it is available independently of
 * `AUTODEV_CONTROL_API_TOKEN`.
 */
export default function MemoryPage(): React.JSX.Element {
  const portal = readMemoryPortalConfig();
  if (!portal) {
    return React.createElement(
      ConsolePageShell,
      { section: SECTION },
      React.createElement(ResourceUnavailable, {
        title: "Memory destination URL is not configured safely",
        code: "autodev_memory_portal_url_invalid",
        message:
          "AUTODEV_OPENLIT_UI_URL must be an http or https URL with no embedded credentials.",
        hint: "Set AUTODEV_OPENLIT_UI_URL in the Next.js server environment, or unset it to use the local default."
      })
    );
  }
  return React.createElement(
    ConsolePageShell,
    { section: SECTION },
    React.createElement(MemoryPortalCard, { href: portal.href })
  );
}
