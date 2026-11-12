import type { ProjectTemplate } from "@forge/protocol";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { syncProjectApis } from "./connections.ts";
import { db, schema } from "./db/index.ts";
import { appendEvent } from "./events.ts";
import { activeRunId } from "./runs.ts";
import { containerName, docker, ensureSandbox, exec, setTemplateSeeder } from "./sandbox.ts";
import { listSecrets } from "./secrets.ts";

/*
 * Team templates: a saved project version that new projects start from.
 *
 * Saving takes `git archive HEAD` of the source project (tracked files only, so no
 * node_modules, build output or local env files), plus the project's API connections,
 * its own brain notes and the names (never values) of its secrets.
 * A new project from a template gets the files (dependencies reinstalled), the same API
 * connections, a copy of the notes, and a feed notice listing secrets to add.
 */

const MAX_ARCHIVE_B64 = 25 * 1024 * 1024;

export class TemplateError extends Error {}

export async function createTemplate(
  input: { projectId: string; name: string; description?: string },
  user: { name: string },
): Promise<ProjectTemplate> {
  const { projectId } = input;
  if (activeRunId(projectId)) throw new TemplateError("Wait for the agent to finish before saving a template.");
  await ensureSandbox(projectId);

  const head = await exec(projectId, ["git", "rev-parse", "HEAD"]);
  if (head.exitCode !== 0) throw new TemplateError("This project has no saved version yet.");
  const sha = head.stdout.trim();
  const arch = await exec(projectId, ["sh", "-c", "git archive --format=tar.gz HEAD | base64 -w0"]);
  if (arch.exitCode !== 0 || !arch.stdout) throw new TemplateError(`Packing the project failed: ${arch.stderr.slice(0, 300)}`);
  if (arch.stdout.length > MAX_ARCHIVE_B64) throw new TemplateError("This project is too large to save as a template (over about 18 MB).");

  const connections = await db
    .select({ id: schema.projectApiConnection.connectionId })
    .from(schema.projectApiConnection)
    .where(eq(schema.projectApiConnection.projectId, projectId));
  const notes = await db
    .select({ title: schema.brainDoc.title, content: schema.brainDoc.content })
    .from(schema.brainDoc)
    .where(eq(schema.brainDoc.projectId, projectId));
  const secretNames = (await listSecrets(projectId)).map((s) => s.name);

  const id = nanoid(12);
  await db.insert(schema.projectTemplate).values({
    id,
    name: input.name,
    description: input.description || null,
    sourceProjectId: projectId,
    sourceSha: sha,
    archive: arch.stdout,
    sizeBytes: Math.round((arch.stdout.length * 3) / 4),
    connectionIds: connections.map((c) => c.id),
    notes,
    secretNames,
    createdBy: user.name,
  });
  const all = await listTemplates();
  return all.find((t) => t.id === id)!;
}

export async function listTemplates(): Promise<ProjectTemplate[]> {
  const rows = await db
    .select({
      t: {
        id: schema.projectTemplate.id,
        name: schema.projectTemplate.name,
        description: schema.projectTemplate.description,
        sourceProjectId: schema.projectTemplate.sourceProjectId,
        sourceSha: schema.projectTemplate.sourceSha,
        sizeBytes: schema.projectTemplate.sizeBytes,
        connectionIds: schema.projectTemplate.connectionIds,
        notes: schema.projectTemplate.notes,
        secretNames: schema.projectTemplate.secretNames,
        createdBy: schema.projectTemplate.createdBy,
        createdAt: schema.projectTemplate.createdAt,
      },
      projectName: schema.project.name,
    })
    .from(schema.projectTemplate)
    .leftJoin(schema.project, eq(schema.project.id, schema.projectTemplate.sourceProjectId))
    .orderBy(desc(schema.projectTemplate.createdAt));
  const conns = await db.select({ id: schema.apiConnection.id, name: schema.apiConnection.name }).from(schema.apiConnection);
  const connName = new Map(conns.map((c) => [c.id, c.name]));
  return rows.map(({ t, projectName }) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    sourceProjectId: t.sourceProjectId,
    sourceProjectName: projectName,
    sourceSha: t.sourceSha,
    sizeBytes: t.sizeBytes,
    apis: t.connectionIds.flatMap((id) => (connName.has(id) ? [connName.get(id)!] : [])),
    notes: t.notes.length,
    secretNames: t.secretNames,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
  }));
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const rows = await db.delete(schema.projectTemplate).where(eq(schema.projectTemplate.id, id)).returning({ id: schema.projectTemplate.id });
  return rows.length > 0;
}

/** Called when a project is created from a template: copy connections and notes, announce needed secrets. */
export async function applyTemplateToNewProject(projectId: string, templateId: string, user: { name: string }) {
  const [t] = await db.select().from(schema.projectTemplate).where(eq(schema.projectTemplate.id, templateId));
  if (!t) throw new TemplateError("That template no longer exists.");
  const existing = new Set((await db.select({ id: schema.apiConnection.id }).from(schema.apiConnection)).map((c) => c.id));
  const ids = t.connectionIds.filter((id) => existing.has(id));
  if (ids.length) await db.insert(schema.projectApiConnection).values(ids.map((connectionId) => ({ projectId, connectionId })));
  for (const [i, n] of t.notes.entries()) {
    await db.insert(schema.brainDoc).values({
      id: nanoid(12),
      projectId,
      title: n.title,
      content: n.content,
      position: i,
      updatedBy: user.name,
    });
  }
  const runId = `template-${nanoid(8)}`;
  await appendEvent({
    type: "notice",
    projectId,
    runId,
    text:
      `Started from the team template "${t.name}".` +
      (t.secretNames.length
        ? ` It expects these secrets, which aren't copied: ${t.secretNames.join(", ")}. Add them with the Secrets button.`
        : ""),
  });
}

/** Seeds a new project's workspace from its template (registered with the sandbox module). */
async function seedFromTemplate(projectId: string) {
  const [row] = await db
    .select({ templateId: schema.project.templateId })
    .from(schema.project)
    .where(eq(schema.project.id, projectId));
  const [t] = row?.templateId
    ? await db.select().from(schema.projectTemplate).where(eq(schema.projectTemplate.id, row.templateId))
    : [];
  if (!t) throw new Error("This project's template no longer exists.");

  // Start from the pre-installed base app (warm node_modules), then replace every tracked file.
  const base = await exec(projectId, [
    "sh",
    "-c",
    "cp -a /opt/forge/template/. /workspace/ && find /workspace -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +",
  ]);
  if (base.exitCode !== 0) throw new Error(`Preparing the workspace failed: ${base.stderr || base.stdout}`);
  // Docker extracts gzip-compressed tar archives directly.
  await docker.getContainer(containerName(projectId)).putArchive(Buffer.from(t.archive, "base64"), { path: "/workspace" });
  const own = await exec(projectId, ["chown", "-R", "forge:forge", "/workspace"], { user: "root" });
  if (own.exitCode !== 0) throw new Error(`Preparing the workspace failed: ${own.stderr}`);
  const init = await exec(projectId, [
    "sh",
    "-c",
    'pnpm install --prefer-offline --reporter=silent && git init -q && git add -A && git commit -qm "$1"',
    "sh",
    `Start from the team template "${t.name}"`,
  ]);
  if (init.exitCode !== 0) throw new Error(`Installing the template's dependencies failed: ${(init.stderr || init.stdout).slice(-500)}`);

  // API files include a git-ignored env file the archive can't carry: regenerate them
  // once the sandbox has finished starting (syncProjectApis itself waits for the sandbox).
  if (t.connectionIds.length) {
    void ensureSandbox(projectId)
      .then(() => syncProjectApis(projectId, "Connect the template's APIs"))
      .catch((e) => console.error("template API sync failed", e));
  }
}

setTemplateSeeder(seedFromTemplate);
