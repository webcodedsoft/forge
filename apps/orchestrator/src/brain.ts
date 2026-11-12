import type { BrainDoc, BrainDocInput } from "@forge/protocol";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { db, schema } from "./db/index.ts";

/*
 * Team brain: Markdown guidance appended to the agent's system prompt on every
 * turn. Team docs (projectId null) apply to all projects; project docs only to
 * their project. Disabled docs are kept but not sent.
 */

const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);
/** Upper bound for brain text in one prompt (~10k tokens). */
const MAX_PROMPT_CHARS = 40_000;

export class BrainError extends Error {}

const toDoc = (r: typeof schema.brainDoc.$inferSelect): BrainDoc => ({
  id: r.id,
  projectId: r.projectId,
  title: r.title,
  content: r.content,
  enabled: r.enabled,
  updatedBy: r.updatedBy,
  updatedAt: r.updatedAt.toISOString(),
});

/** Team docs, plus the project's own docs when projectId is given. */
export async function listDocs(projectId?: string): Promise<BrainDoc[]> {
  const where = projectId
    ? or(isNull(schema.brainDoc.projectId), eq(schema.brainDoc.projectId, projectId))
    : isNull(schema.brainDoc.projectId);
  const rows = await db
    .select()
    .from(schema.brainDoc)
    .where(where)
    .orderBy(asc(schema.brainDoc.position), asc(schema.brainDoc.createdAt));
  return rows.map(toDoc);
}

export async function createDoc(input: BrainDocInput, userName: string): Promise<BrainDoc> {
  const [row] = await db
    .insert(schema.brainDoc)
    .values({
      id: newId(),
      projectId: input.projectId ?? null,
      title: input.title,
      content: input.content,
      enabled: input.enabled,
      position: Date.now() % 2_000_000_000,
      updatedBy: userName,
    })
    .returning();
  return toDoc(row!);
}

export async function updateDoc(id: string, input: Omit<BrainDocInput, "projectId">, userName: string): Promise<BrainDoc> {
  const [row] = await db
    .update(schema.brainDoc)
    .set({ title: input.title, content: input.content, enabled: input.enabled, updatedBy: userName })
    .where(eq(schema.brainDoc.id, id))
    .returning();
  if (!row) throw new BrainError("Document not found.");
  return toDoc(row);
}

export async function deleteDoc(id: string) {
  await db.delete(schema.brainDoc).where(eq(schema.brainDoc.id, id));
}

/** The brain section of the agent's system prompt for a project ("" when empty). */
export async function brainPrompt(projectId: string): Promise<string> {
  const rows = await db
    .select()
    .from(schema.brainDoc)
    .where(
      and(
        eq(schema.brainDoc.enabled, true),
        or(isNull(schema.brainDoc.projectId), eq(schema.brainDoc.projectId, projectId)),
      ),
    )
    .orderBy(asc(schema.brainDoc.position), asc(schema.brainDoc.createdAt));
  if (rows.length === 0) return "";

  const team = rows.filter((r) => r.projectId === null);
  const project = rows.filter((r) => r.projectId !== null);
  const section = (r: (typeof rows)[number]) => `### ${r.title}\n\n${r.content.trim()}\n`;
  let text = [
    "## Team brain",
    "",
    "These are our team's standing instructions. Follow them in every change. Project notes override team docs when they conflict; the user's current request overrides both.",
    "Existing code does not override these docs: new or changed UI follows them even if older parts of the app look different. When older code doesn't match (for example a different button color), say so in your final message so the user can ask for a cleanup; don't restyle unrelated parts unasked.",
    "",
    ...team.map(section),
    ...(project.length ? ["## Notes for this project", "", ...project.map(section)] : []),
  ].join("\n");
  if (text.length > MAX_PROMPT_CHARS) {
    text = text.slice(0, MAX_PROMPT_CHARS) + "\n\n(The team brain was cut off here because it is too long.)";
  }
  return text;
}

/* ------------------------------ starter docs ------------------------------ */

const STARTER: { title: string; content: string }[] = [
  {
    title: "Engineering rules",
    content: `- Data comes only from our in-house APIs through the generated clients in \`src/lib/forge-api/\`. No local databases, no mock data in shipped code.
- Never build generic URL-fetching or proxy routes (for example \`/api/fetch?url=...\` or image proxies for arbitrary URLs). If external content is needed, ask the user first and limit it to an explicit allow-list of hosts.
- Never put tokens, keys or secrets in browser code or in the repo.
- Validate all user input with zod before sending it to an API, and show the validation message next to the field.
- Never render API or user content with \`dangerouslySetInnerHTML\`.
- Server Components by default; \`"use client"\` only for interactive parts. Keep components small (under ~200 lines) and named after what they show.
- Every data view handles loading, empty and error states. A 401/403 shows "You don't have access to this" rather than an error dump.`,
  },
  {
    title: "Design system",
    content: `Edit this to match our brand.

- Primary color: Tailwind \`indigo-600\` (hover \`indigo-700\`) for main actions; neutral \`zinc\` for everything else.
- Corners: \`rounded-lg\` for cards and inputs, \`rounded-md\` for buttons.
- Spacing: generous; page content max width \`max-w-5xl\`, centered.
- Typography: the app's default sans font; page titles \`text-2xl font-semibold\`.
- Support light and dark mode with Tailwind's \`dark:\` variants.
- Icons: use \`lucide-react\` (the icon set shadcn/ui uses; browse at https://lucide.dev/icons or https://www.shadcn.io/icons), e.g. \`import { Search } from "lucide-react"\` and \`<Search className="size-4" aria-hidden />\`. Never use emoji, icon fonts or hand-drawn SVGs as UI icons. Install it with \`pnpm add lucide-react\` if the project doesn't have it. Icon-only buttons need an \`aria-label\`.
- Accessibility: every control has a visible label or \`aria-label\`; color is never the only signal; focus rings stay visible.`,
  },
  {
    title: "UI writing style",
    content: `- Plain, friendly and short. Write for a busy colleague, not an engineer.
- Buttons say what they do ("Save changes", "Request access"), never "Submit" or "OK".
- Errors say what happened and what to do next, without codes or stack traces.
- Use sentence case for titles and buttons.`,
  },
];

/** Add the starter team docs (skips titles that already exist). */
export async function addStarterDocs(userName: string): Promise<BrainDoc[]> {
  const existing = new Set((await listDocs()).map((d) => d.title));
  for (const [i, d] of STARTER.entries()) {
    if (existing.has(d.title)) continue;
    await db.insert(schema.brainDoc).values({
      id: newId(),
      projectId: null,
      title: d.title,
      content: d.content,
      enabled: true,
      position: i,
      updatedBy: userName,
    });
  }
  return listDocs();
}
