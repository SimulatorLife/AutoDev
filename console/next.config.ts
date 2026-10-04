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
  }
};

export default nextConfig;
