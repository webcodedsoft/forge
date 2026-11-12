"use client";

import type { PresenceUser, RunEvent, ServerFrame } from "@forge/protocol";
import { useEffect, useRef, useState } from "react";

/** Orchestrator websocket. The browser connects directly; auth cookies are shared across localhost ports. */
function wsUrl() {
  if (process.env.NEXT_PUBLIC_FORGE_WS_URL) return process.env.NEXT_PUBLIC_FORGE_WS_URL;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  // Local dev: the web app (4310) and orchestrator (8790) are separate ports.
  // Deployed: Caddy routes /api/ws on the same host to the orchestrator.
  if (window.location.port === "4310") return `${proto}://${window.location.hostname}:8790/api/ws`;
  return `${proto}://${window.location.host}/api/ws`;
}

export type LiveState = {
  events: RunEvent[];
  /** Streamed assistant text for the current run (cleared when the final message lands). */
  streaming: { runId: string; text: string } | null;
  connected: boolean;
  caughtUp: boolean;
  /** Latest live frame of the QA agent's browser (base64 JPEG), while a QA run is active. */
  qaFrame: { runId: string; data: string } | null;
  /** Teammates with this project open right now (including you). */
  presence: PresenceUser[];
  /** Bumps whenever someone adds, resolves or deletes a comment. */
  commentsVersion: number;
  /** Bumped when the app's recorded problems change (Fix from logs). */
  problemsVersion: number;
  /** Bumped when a new security report is ready. */
  securityVersion: number;
};

export function useProjectEvents(projectId: string): LiveState {
  // Tagged with the project they belong to, so a project switch shows nothing stale.
  const [log, setLog] = useState<{ projectId: string; events: RunEvent[] }>({ projectId, events: [] });
  const [streaming, setStreaming] = useState<LiveState["streaming"]>(null);
  const [connected, setConnected] = useState(false);
  const [caughtUpFor, setCaughtUpFor] = useState<string | null>(null);
  const [qaFrame, setQaFrame] = useState<LiveState["qaFrame"]>(null);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [commentsVersion, setCommentsVersion] = useState(0);
  const [problemsVersion, setProblemsVersion] = useState(0);
  const [securityVersion, setSecurityVersion] = useState(0);
  const lastSeq = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    lastSeq.current = 0;

    const connect = () => {
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        ws!.send(JSON.stringify({ type: "subscribe", projectId, after: lastSeq.current }));
      };
      ws.onmessage = (msg) => {
        const frame = JSON.parse(String(msg.data)) as ServerFrame;
        if (frame.type === "event") {
          const e = frame.event;
          if (e.seq <= lastSeq.current) return;
          lastSeq.current = e.seq;
          setLog((prev) => (prev.projectId === projectId ? { projectId, events: [...prev.events, e] } : { projectId, events: [e] }));
          if (e.type === "assistant.message" || e.type === "tool.call" || e.type === "run.finished") setStreaming(null);
          if (e.type === "run.finished") setQaFrame(null);
        } else if (frame.type === "qa_frame") {
          setQaFrame({ runId: frame.runId, data: frame.data });
        } else if (frame.type === "delta") {
          setStreaming((s) => (s && s.runId === frame.runId ? { runId: s.runId, text: s.text + frame.text } : { runId: frame.runId, text: frame.text }));
        } else if (frame.type === "presence") {
          setPresence(frame.users);
        } else if (frame.type === "security_changed") {
          setSecurityVersion((v) => v + 1);
        } else if (frame.type === "problems_changed") {
          setProblemsVersion((v) => v + 1);
        } else if (frame.type === "comments_changed") {
          setCommentsVersion((v) => v + 1);
        } else if (frame.type === "caught_up") {
          setCaughtUpFor(projectId);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();

    const ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), 25_000);
    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(ping);
      ws?.close();
    };
  }, [projectId]);

  const events = log.projectId === projectId ? log.events : [];
  return { events, streaming, connected, caughtUp: caughtUpFor === projectId, qaFrame, presence, commentsVersion, problemsVersion, securityVersion };
}
