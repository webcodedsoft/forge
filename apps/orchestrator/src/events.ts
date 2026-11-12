import type { NewRunEvent, RunEvent, ServerFrame } from "@forge/protocol";
import { and, asc, eq, gt, max } from "drizzle-orm";
import { db, schema } from "./db/index.ts";

/*
 * Append-only, per-project event log with live fan-out.
 * Appends for one project are serialized so `seq` is gap-free and ordered.
 */

type Listener = (frame: ServerFrame) => void;

const lastSeq = new Map<string, number>();
const tails = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<Listener>>();

async function nextSeq(projectId: string): Promise<number> {
  let seq = lastSeq.get(projectId);
  if (seq === undefined) {
    const [row] = await db
      .select({ seq: max(schema.projectEvent.seq) })
      .from(schema.projectEvent)
      .where(eq(schema.projectEvent.projectId, projectId));
    seq = row?.seq ?? 0;
  }
  seq += 1;
  lastSeq.set(projectId, seq);
  return seq;
}

export function appendEvent(input: NewRunEvent): Promise<RunEvent> {
  const projectId = input.projectId;
  const prev = tails.get(projectId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const seq = await nextSeq(projectId);
    const event = { ...input, seq, at: new Date().toISOString() } as RunEvent;
    await db.insert(schema.projectEvent).values({
      projectId,
      seq,
      runId: event.runId,
      type: event.type,
      payload: event,
      at: new Date(event.at),
    });
    publish(projectId, { type: "event", event });
    return event;
  });
  // Keep the chain alive even if one append fails.
  tails.set(projectId, next.catch(() => undefined));
  return next;
}

export async function listEvents(projectId: string, after = 0, limit = 5000): Promise<RunEvent[]> {
  const rows = await db
    .select({ payload: schema.projectEvent.payload })
    .from(schema.projectEvent)
    .where(and(eq(schema.projectEvent.projectId, projectId), gt(schema.projectEvent.seq, after)))
    .orderBy(asc(schema.projectEvent.seq))
    .limit(limit);
  return rows.map((r) => r.payload as RunEvent);
}

export function publish(projectId: string, frame: ServerFrame): void {
  for (const fn of listeners.get(projectId) ?? []) {
    try {
      fn(frame);
    } catch {
      /* a broken listener must not affect others */
    }
  }
}

export function subscribe(projectId: string, fn: Listener): () => void {
  let set = listeners.get(projectId);
  if (!set) listeners.set(projectId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(projectId);
  };
}
