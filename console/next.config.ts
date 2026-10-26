import type { NextConfig } from "next";

import { consoleDistDir } from "./src/lib/build-output.ts";
import { ROUTER_STALE_SECONDS } from "./src/lib/router-staleness.ts";

export default function nextConfig(phase: string): NextConfig {
  return {
    distDir: consoleDistDir(phase),
    reactStrictMode: true,
    // The Console's pages are live, so the router's reuse window is the
    // Console's own live-count cadence -- and the two windows are the same
    // number on purpose: they make the router's `stale` branch unreachable,
    // and that branch is the one where a navigation never commits. See
    // `src/lib/router-staleness.ts` for the whole of it.
    experimental: {
      staleTimes: {
        dynamic: ROUTER_STALE_SECONDS,
        static: ROUTER_STALE_SECONDS
      }
    },
    poweredByHeader: false,
    transpilePackages: [
      "@simulatorlife/autodev-core",
      "@simulatorlife/autodev-data"
    ],
    eslint: {
      ignoreDuringBuilds: true
    }
  };
}
