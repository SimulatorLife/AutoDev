import type { NextConfig } from "next";

import { consoleDistDir } from "./src/lib/build-output.ts";
import {
  ROUTER_STALE_SECONDS,
  ROUTER_STATIC_STALE_SECONDS
} from "./src/lib/router-staleness.ts";

export default function nextConfig(phase: string): NextConfig {
  return {
    distDir: consoleDistDir(phase),
    reactStrictMode: true,
    // The Console's pages are live, so the dynamic reuse window matches the
    // Console's own live-count cadence; Next.js 16 requires static >= 30. See
    // `src/lib/router-staleness.ts` for details.
    experimental: {
      staleTimes: {
        dynamic: ROUTER_STALE_SECONDS,
        static: ROUTER_STATIC_STALE_SECONDS
      }
    },
    poweredByHeader: false,
    transpilePackages: [
      "@simulatorlife/autodev-core",
      "@simulatorlife/autodev-data"
    ]
  };
}
