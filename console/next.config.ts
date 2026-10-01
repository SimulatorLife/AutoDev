import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    "@simulatorlife/autodev-core",
    "@simulatorlife/autodev-data"
  ]
};

export default nextConfig;
