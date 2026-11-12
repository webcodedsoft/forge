import { ClientFrame, type PresenceUser, type ServerFrame } from "@forge/protocol";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { projectRole } from "./access.ts";
import { auth } from "./auth.ts";
import { env } from "./env.ts";
import { listEvents, publish, subscribe } from "./events.ts";

/*
 * Live event stream at ws://localhost:<ORCHESTRATOR_PORT>/api/ws.
 * The browser connects directly (cookies are shared across localhost ports),
 * so we check the Origin and the Better Auth session on upgrade.
 */

const allowedOrigin = new URL(env.BETTER_AUTH_URL).origin;

function toHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") h.set(k, v);
    else if (Array.isArray(v)) h.set(k, v.join(", "));
  }
  return h;
}

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/ws") return; // not ours
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (req.headers.origin !== allowedOrigin) return reject(403, "Forbidden");
    const session = await auth.api.getSession({ headers: toHeaders(req) }).catch(() => null);
    if (!session) return reject(401, "Unauthorized");
    const viewer = { id: session.user.id, name: session.user.name };
    wss.handleUpgrade(req, socket, head, (ws) => handle(ws, viewer));
  });
}

/* ------------------------------- Presence ------------------------------- */

type Viewer = { id: string; name: string };
/** projectId → connection → viewer. One person with two tabs is two connections, shown once. */
const viewers = new Map<string, Map<WebSocket, Viewer & { since: Date }>>();

function broadcastPresence(projectId: string) {
  const byUser = new Map<string, PresenceUser>();
  for (const v of viewers.get(projectId)?.values() ?? []) {
    const prev = byUser.get(v.id);
    if (!prev || v.since.toISOString() < prev.since) byUser.set(v.id, { id: v.id, name: v.name, since: v.since.toISOString() });
  }
  const users = [...byUser.values()].sort((a, b) => a.since.localeCompare(b.since));
  publish(projectId, { type: "presence", projectId, users });
}

function join(projectId: string, ws: WebSocket, viewer: Viewer) {
  let set = viewers.get(projectId);
  if (!set) viewers.set(projectId, (set = new Map()));
  set.set(ws, { ...viewer, since: new Date() });
  broadcastPresence(projectId);
}

function leave(projectId: string, ws: WebSocket) {
  const set = viewers.get(projectId);
  if (!set?.delete(ws)) return;
  if (set.size === 0) viewers.delete(projectId);
  broadcastPresence(projectId);
}

function handle(ws: WebSocket, viewer: Viewer) {
  const unsubs = new Map<string, () => void>();
  const send = (f: ServerFrame) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f));
  };

  ws.on("message", async (data) => {
    let frame: ClientFrame;
    try {
      frame = ClientFrame.parse(JSON.parse(String(data)));
    } catch {
      return send({ type: "error", message: "Invalid frame" });
    }
    if (frame.type === "ping") return send({ type: "pong" });

    const { projectId, after } = frame;
    // Only people with access to the project may watch it.
    if (!(await projectRole(viewer.id, projectId))) return send({ type: "error", message: "No access to this project" });
    unsubs.get(projectId)?.();
    // Subscribing (or re-subscribing) here also marks this viewer present in the project.
    for (const other of unsubs.keys()) if (other !== projectId) leave(other, ws);
    // Buffer live frames until the replay is sent, then flush in order.
    const pending: ServerFrame[] = [];
    let replaying = true;
    unsubs.set(
      projectId,
      subscribe(projectId, (f) => (replaying ? pending.push(f) : send(f))),
    );
    const history = await listEvents(projectId, after);
    let last = after;
    for (const event of history) {
      send({ type: "event", event });
      last = event.seq;
    }
    replaying = false;
    join(projectId, ws, viewer);
    for (const f of pending) {
      if (f.type === "event" && f.event.seq <= last) continue;
      send(f);
      if (f.type === "event") last = f.event.seq;
    }
    send({ type: "caught_up", projectId, seq: last });
  });

  ws.on("close", () => {
    for (const projectId of unsubs.keys()) leave(projectId, ws);
    for (const u of unsubs.values()) u();
    unsubs.clear();
  });
}
