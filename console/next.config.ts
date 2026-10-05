import type { NextConfig } from "next";

import { consoleDistDir } from "./src/lib/build-output.ts";

export default function nextConfig(phase: string): NextConfig {
  return {
    distDir: consoleDistDir(phase),
    reactStrictMode: true,
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
