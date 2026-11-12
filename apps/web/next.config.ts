import type { NextConfig } from "next";

const orchestrator = `http://127.0.0.1:${process.env.ORCHESTRATOR_PORT ?? "8790"}`;

const nextConfig: NextConfig = {
  cacheComponents: true,
  // The dev badge sat on top of the prompt box's + button. Errors still show in the overlay.
  devIndicators: false,
  partialPrefetching: true,
  transpilePackages: ["@forge/protocol"],
  experimental: {
    // Uploads (attachments 10 MB, spreadsheets 20 MB) arrive base64-encoded through the /api rewrite.
    proxyClientMaxBodySize: "32mb",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // The browser only talks to this app; /api is proxied to the orchestrator so
  // auth cookies stay first-party on one origin.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${orchestrator}/api/:path*` }];
  },
};

export default nextConfig;
