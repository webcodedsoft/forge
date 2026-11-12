import type { LibraryComponent } from "@forge/protocol";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "./db/index.ts";
import { exec, putFiles } from "./sandbox.ts";

/*
 * Team component library. The build agent saves a self-contained component with the
 * `save_to_library` tool (the runner reads the files from disk, so the stored code is
 * exactly what was built). Before every build turn the library is copied into the
 * project at .forge/library/ (git-excluded) and listed in the agent's system prompt,
 * so any project can reuse it.
 */

export const COMPONENT_NAME = /^[a-z][a-z0-9-]{1,47}$/;

export type ComponentInput = {
  name: string;
  title: string;
  description: string;
  usage: string;
  files: { path: string; content: string }[];
  dependencies: string[];
};

/** Validates what the runner sent; returns an error message, or null. */
export function checkComponent(c: ComponentInput): string | null {
  if (!COMPONENT_NAME.test(c.name)) return "name must be kebab-case, 2-48 characters";
  if (!c.files.length || c.files.length > 20) return "save 1 to 20 files";
  const total = c.files.reduce((n, f) => n + f.content.length, 0);
  if (total > 300_000) return "files are too large (300 KB total)";
  for (const f of c.files) {
    if (f.path.startsWith("/") || f.path.split("/").includes("..") || f.path.startsWith(".forge/")) return `unsafe path ${f.path}`;
  }
  if (c.dependencies.some((d) => !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[\w.^~<>=*-]+)?$/i.test(d))) return "invalid dependency name";
  return null;
}

/** Saves (or replaces, by name) a component. */
export async function saveComponent(c: ComponentInput, sourceProjectId: string, userName: string) {
  const values = {
    title: c.title.slice(0, 120),
    description: c.description.slice(0, 1000),
    usage: c.usage.slice(0, 4000),
    files: c.files,
    dependencies: c.dependencies,
    sourceProjectId,
    createdBy: userName,
  };
  await db
    .insert(schema.libraryComponent)
    .values({ id: nanoid(12), name: c.name, ...values })
    .onConflictDoUpdate({ target: schema.libraryComponent.name, set: { ...values, updatedAt: new Date() } });
}

export async function listComponents(): Promise<LibraryComponent[]> {
  const rows = await db
    .select({ c: schema.libraryComponent, projectName: schema.project.name })
    .from(schema.libraryComponent)
    .leftJoin(schema.project, eq(schema.project.id, schema.libraryComponent.sourceProjectId))
    .orderBy(asc(schema.libraryComponent.name));
  return rows.map(({ c, projectName }) => ({
    id: c.id,
    name: c.name,
    title: c.title,
    description: c.description,
    usage: c.usage,
    files: c.files,
    dependencies: c.dependencies,
    sourceProjectId: c.sourceProjectId,
    sourceProjectName: projectName,
    createdBy: c.createdBy,
    updatedAt: c.updatedAt.toISOString(),
  }));
}

export async function deleteComponent(id: string): Promise<boolean> {
  const rows = await db.delete(schema.libraryComponent).where(eq(schema.libraryComponent.id, id)).returning({ id: schema.libraryComponent.id });
  return rows.length > 0;
}

/** Copies the library into the project's .forge/library/ (git-excluded), replacing any old copy. */
export async function syncLibrary(projectId: string) {
  const items = await listComponents();
  await exec(projectId, [
    "sh",
    "-c",
    "rm -rf .forge/library && mkdir -p .git/info && (grep -qx '.forge/library/' .git/info/exclude 2>/dev/null || echo '.forge/library/' >> .git/info/exclude)",
  ]);
  if (!items.length) return;
  const files = items.flatMap((c) => [
    {
      path: `.forge/library/${c.name}/README.md`,
      content: `# ${c.title}\n\n${c.description}\n\n## Usage\n\n${c.usage}\n\n## Dependencies\n\n${
        c.dependencies.length ? c.dependencies.map((d) => `- ${d}`).join("\n") : "None beyond the base app."
      }\n\n## Files\n\n${c.files.map((f) => `- ${f.path}`).join("\n")}\n`,
    },
    ...c.files.map((f) => ({ path: `.forge/library/${c.name}/${f.path}`, content: f.content })),
  ]);
  await putFiles(projectId, files);
}

/**
 * A one-line reminder appended to each build request (not shown in the chat). Rules in the
 * system prompt alone were ignored in testing; a note next to the request is acted on.
 */
export async function libraryReminder(): Promise<string> {
  const items = await listComponents();
  if (!items.length) return "";
  const names = items.map((c) => `\`${c.name}\` (${c.title})`).join(", ");
  return `\n\n(Forge note: the team component library in .forge/library/ has ${names}. Before writing new UI, check whether one fits this request; if it does, reuse it and say so. If a related one doesn't fit, say why in one sentence.)`;
}

/** System-prompt section: what's in the library and how to use and add to it. */
export async function libraryPrompt(): Promise<string> {
  const items = await listComponents();
  const list = items.length
    ? items.map((c) => `- \`${c.name}\`: ${c.title}. ${c.description.split("\n")[0]}`).join("\n")
    : "- (empty so far)";
  return `## Team component library

Reusable components the team has saved, copied into this project at \`.forge/library/<name>/\` (read its README.md for usage, dependencies and files). This folder is a read-only reference and is not part of the app.
${list}

- Before building any new UI piece (cards, lists, forms, banners, voting, tables…), check this list. If a component fits or nearly fits, reuse it: copy its files into the app (keep the same paths unless they clash), install its dependencies with \`pnpm add\`, and adapt it through its props or small edits. Tell the user you reused it, by name.
- If a library component looks related but you build something new instead, say in one sentence which one and why it didn't fit, so the team can improve the library.
- When the user asks to save, share or reuse a component, first make it self-contained (props for the data and labels, no page-specific imports except shared helpers you also save), then call \`save_to_library\` with every file it needs. Saving under an existing name replaces that component for the whole team, so check the list first.`;
}
