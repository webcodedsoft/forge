import type { QueuedMessage, RunMode } from "@forge/protocol";
import { asc, and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "./db/index.ts";
import { publish } from "./events.ts";
import { isRunning, RunConflictError, startRun } from "./runs.ts";

/*
 * Message queue: people can keep sending while the agent works. A request sent during a run is
 * stored here and started when the run ends, oldest first, one at a time, as the person who
 * sent it. Stored in the database, so a reload or an orchestrator restart doesn't lose it.
 * After Stop, the queue waits until someone presses "Run next" (they may want to rethink).
 */

const MAX_QUEUED = 20;

export class QueueError extends Error {}

const changed = (projectId: string) => publish(projectId, { type: "queue_changed", projectId });

export async function listQueue(projectId: string): Promise<QueuedMessage[]> {
  const rows = await db
    .select()
    .from(schema.queuedMessage)
    .where(eq(schema.queuedMessage.projectId, projectId))
    .orderBy(asc(schema.queuedMessage.createdAt));
  return rows.map((r) => ({
    id: r.id,
    prompt: r.prompt,
    mode: r.mode as RunMode,
    model: r.model,
    userId: r.userId,
    userName: r.userName,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function enqueue(projectId: string, prompt: string, mode: RunMode, user: { id: string; name: string }, model?: string | null) {
  const queued = await listQueue(projectId);
  if (queued.length >= MAX_QUEUED) throw new QueueError(`Up to ${MAX_QUEUED} messages can wait in the queue.`);
  const id = nanoid(10);
  await db.insert(schema.queuedMessage).values({ id, projectId, prompt, mode, model: model ?? null, userId: user.id, userName: user.name });
  changed(projectId);
  // The run may have ended while we were saving: start it now instead of waiting.
  if (!isRunning(projectId)) void runNext(projectId);
  return { queuedId: id, position: queued.length + 1 };
}

export async function removeQueued(projectId: string, id: string): Promise<boolean> {
  const gone = await db
    .delete(schema.queuedMessage)
    .where(and(eq(schema.queuedMessage.projectId, projectId), eq(schema.queuedMessage.id, id)))
    .returning({ id: schema.queuedMessage.id });
  if (gone.length) changed(projectId);
  return gone.length > 0;
}

export async function hasQueued(projectId: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.queuedMessage.id }).from(schema.queuedMessage).where(eq(schema.queuedMessage.projectId, projectId)).limit(1);
  return Boolean(row);
}

const starting = new Set<string>();

/** Start the oldest queued message, if the agent is free. Returns the run id, or null. */
export async function runNext(projectId: string): Promise<string | null> {
  if (starting.has(projectId) || isRunning(projectId)) return null;
  starting.add(projectId);
  try {
    const [next] = await listQueue(projectId);
    if (!next) return null;
    // Take it off the queue first, so it can't start twice.
    if (!(await removeQueued(projectId, next.id))) return null;
    try {
      return await startRun(projectId, next.prompt, { id: next.userId, name: next.userName }, next.mode, next.model ?? undefined);
    } catch (err) {
      // Someone started a run in between: put it back at the front.
      await db.insert(schema.queuedMessage).values({
        id: next.id,
        projectId,
        prompt: next.prompt,
        mode: next.mode,
        model: next.model,
        userId: next.userId,
        userName: next.userName,
        createdAt: new Date(next.createdAt),
      });
      changed(projectId);
      if (!(err instanceof RunConflictError)) console.error("queued message did not start", err);
      return null;
    }
  } finally {
    starting.delete(projectId);
  }
}
