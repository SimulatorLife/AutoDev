import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    "@simulatorlife/autodev-core",
    "@simulatorlife/autodev-data"
  ],
  eslint: {
    ignoreDuringBuilds: true
  },
  experimental: {
    // Client router cache lifetimes, in seconds. Pages reached by an
    // ordinary navigation are never reused (`dynamic: 0`), so live runtime
    // state is re-read on every visit. Pages that ConsoleLink fully
    // prefetched on hover, focus, or touch are reused for at most 30 seconds,
    // the shortest window Next.js allows, so a click shortly after pointing
    // at a link renders without a server round trip.
    staleTimes: { dynamic: 0, static: 30 }
  }
};

export default nextConfig;
