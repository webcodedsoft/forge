import type { MetadataRoute } from "next";

/** Installable app (browser "Install" / Android home screen). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Forge",
    short_name: "Forge",
    description: "Our team's AI app builder",
    start_url: "/",
    display: "standalone",
    background_color: "#0f1115",
    theme_color: "#5b2ce2",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
