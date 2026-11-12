import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app runs inside a Forge sandbox and is shown in an iframe at its preview
  // address (Forge sets FORGE_PREVIEW_ORIGINS), so allow that origin in dev.
  allowedDevOrigins: (process.env.FORGE_PREVIEW_ORIGINS ?? "*.preview.localhost").split(","),
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
