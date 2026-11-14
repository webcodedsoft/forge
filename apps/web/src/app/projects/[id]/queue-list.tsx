"use client";

import type { QueuedMessage } from "@forge/protocol";
import { ListOrdered, Paperclip, Play, X } from "lucide-react";
import { splitAttachments, splitElementContext } from "@/lib/prompt-parts";

const MODE_LABEL: Record<string, string> = { chat: "Chat", plan: "Plan", design: "Design" };

/**
 * Messages sent while the agent was busy (orchestrator queue.ts). They run in this order when the
 * current request is done. After Stop the queue waits for "Run next".
 */
export function QueueList({
  items,
  running,
  canEdit,
  onRemove,
  onRunNext,
}: {
  items: QueuedMessage[];
  running: boolean;
  canEdit: boolean;
  onRemove: (id: string) => void;
  onRunNext: () => void;
}) {
  return (
    <div className="fade-in rounded-[10px] border border-line bg-surface-2/60" aria-label="Queued messages">
      <div className="flex items-center gap-2 px-3 pb-1 pt-2">
        <ListOrdered size={14} className="text-primary" aria-hidden />
        <p className="text-[12.5px] font-semibold">
          Queued <span className="font-normal text-ink-3">· {items.length}</span>
        </p>
        <p className="truncate text-[12px] text-ink-3">{running ? "runs when the agent is done" : "paused: the last request was stopped"}</p>
        {!running && canEdit && (
          <button type="button" className="btn btn-p btn-sm ml-auto h-7" onClick={onRunNext}>
            <Play size={12} className="fill-current" aria-hidden />
            Run next
          </button>
        )}
      </div>
      <ol className="flex max-h-40 flex-col gap-0.5 overflow-y-auto px-1.5 pb-1.5">
        {items.map((q, i) => {
          const [withoutFiles, files] = splitAttachments(q.prompt);
          const [text, element] = splitElementContext(withoutFiles);
          return (
            <li key={q.id} className="group flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface">
              <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-primary-weak text-[11px] font-bold text-primary">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[13px] leading-snug">{text}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
                  {q.userName}
                  {MODE_LABEL[q.mode] && <span className="pill pill-pri text-[10.5px]">{MODE_LABEL[q.mode]}</span>}
                  {element && <span className="truncate font-mono">{element}</span>}
                  {files.length > 0 && (
                    <span className="flex items-center gap-1">
                      <Paperclip size={11} aria-hidden />
                      {files.length}
                    </span>
                  )}
                </p>
              </div>
              {canEdit && (
                <button
                  type="button"
                  className="btn btn-g btn-icon btn-sm size-6 shrink-0 opacity-60 group-hover:opacity-100"
                  aria-label={`Remove queued message ${i + 1}`}
                  title="Remove from the queue"
                  onClick={() => onRemove(q.id)}
                >
                  <X size={13} aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
