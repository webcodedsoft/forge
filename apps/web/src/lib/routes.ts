/** A page of the generated app, worked out from its files. */
export type AppRoute = { path: string; file: string; dynamic: boolean };

const PAGE_FILE = /^(?:src\/)?app\/(.*?)\/?page\.(?:tsx|jsx|ts|js|mdx)$/;
const PAGES_FILE = /^(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js|mdx)$/;

/**
 * Pages from a Next.js app (App Router `app/**\/page.tsx`, or Pages Router `pages/**`).
 * Route groups `(x)` and parallel slots `@x` are left out of the path; `[param]` marks a
 * page that needs a value.
 */
export function routesFromFiles(files: string[]): AppRoute[] {
  const seen = new Map<string, AppRoute>();
  for (const file of files) {
    let segments: string[] | null = null;
    const app = PAGE_FILE.exec(file);
    if (app) {
      segments = app[1] ? app[1].split("/") : [];
      if (segments.some((s) => s.startsWith("@") || s.startsWith("_"))) continue;
      segments = segments.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
    } else {
      const pages = PAGES_FILE.exec(file);
      if (!pages) continue;
      segments = pages[1]!.split("/");
      if (segments[0] === "api" || segments.some((s) => s.startsWith("_"))) continue;
      if (segments.at(-1) === "index") segments.pop();
    }
    const path = "/" + segments.join("/");
    if (!seen.has(path)) seen.set(path, { path, file, dynamic: segments.some((s) => s.startsWith("[")) });
  }
  return [...seen.values()].sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)));
}
