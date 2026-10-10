import type { NextConfig } from "next";

// Screens retired in the October 2026 cleanup. Bookkeeping now runs through
// the bot API, so old bookmarks land on the nearest read-only page instead of a 404.
const retired: [string, string][] = [
  ['/real-estate/southside/rent', '/real-estate/rent'],
  ['/real-estate/southside/:path*', '/real-estate'],
  ['/real-estate/import/:path*', '/real-estate'],
  ['/real-estate/close', '/real-estate'],
  ['/real-estate/slcm', '/real-estate/companies'],
  ['/real-estate/entity/:slug', '/real-estate/companies/:slug'],
  ['/real-estate/:id(\\d+)/capital', '/real-estate/:id/partners'],
  ['/real-estate/:id(\\d+)/returns', '/real-estate/:id/partners'],
  ['/real-estate/:id(\\d+)/summary', '/real-estate/:id'],
  ['/real-estate/:id(\\d+)/schedules', '/real-estate/:id'],
  ['/real-estate/:id(\\d+)/periods/:path*', '/real-estate/:id/partners'],
];

const nextConfig: NextConfig = {
  async redirects() {
    return retired.map(([source, destination]) => ({ source, destination, permanent: false }));
  },
};

export default nextConfig;
