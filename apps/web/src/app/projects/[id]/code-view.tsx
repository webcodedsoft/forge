"use client";

import { ChevronRight, FileText, Folder, FolderOpen, Search } from "lucide-react";
import { CodeEditor, languageForFile } from "@/components/code-editor";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

type Node = { name: string; path: string; children?: Node[] };

function buildTree(files: string[]): Node[] {
  const root: Node = { name: "", path: "", children: [] };
  for (const f of files) {
    let cur = root;
    const parts = f.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) cur.children!.push({ name: part, path });
      else {
        let next = cur.children!.find((c) => c.children && c.name === part);
        if (!next) cur.children!.push((next = { name: part, path, children: [] }));
        cur = next;
      }
    });
  }
  const sort = (n: Node[]): Node[] =>
    n
      .sort((a, b) => (!!b.children === !!a.children ? a.name.localeCompare(b.name) : a.children ? -1 : 1))
      .map((c) => (c.children ? { ...c, children: sort(c.children) } : c));
  return sort(root.children!);
}

/** Read-only file browser of the project (what git tracks, plus new files). */
export function CodeView({ projectId, files, refreshKey }: { projectId: string; files: string[] | null; refreshKey: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set(["src", "src/app", "app"]));
  const [query, setQuery] = useState("");
  const [file, setFile] = useState<{ path: string; content: string | null; note?: string } | null>(null);

  const tree = useMemo(() => buildTree(files ?? []), [files]);
  const matches = useMemo(
    () => (query.trim() ? (files ?? []).filter((f) => f.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 200) : null),
    [files, query],
  );
  const current = selected ?? (files ?? []).find((f) => /(^|\/)app\/page\.(tsx|jsx)$/.test(f)) ?? files?.[0] ?? null;

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    api.fileContent(projectId, current).then(
      (r) =>
        !cancelled &&
        setFile({
          path: r.path,
          content: r.content,
          note: r.tooLarge ? "This file is too large to show here." : r.binary ? "This is a binary file." : undefined,
        }),
      (e) => !cancelled && setFile({ path: current, content: null, note: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, current, refreshKey]);

  const renderNodes = (nodes: Node[], depth: number): React.ReactNode =>
    nodes.map((n) =>
      n.children ? (
        <div key={n.path}>
          <button
            type="button"
            onClick={() =>
              setOpenDirs((s) => {
                const next = new Set(s);
                if (next.has(n.path)) next.delete(n.path);
                else next.add(n.path);
                return next;
              })
            }
            aria-expanded={openDirs.has(n.path)}
            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[13px] hover:bg-surface-2"
            style={{ paddingLeft: 6 + depth * 12 }}
          >
            <ChevronRight size={13} className={`shrink-0 text-ink-3 transition-transform ${openDirs.has(n.path) ? "rotate-90" : ""}`} aria-hidden />
            {openDirs.has(n.path) ? <FolderOpen size={14} className="shrink-0 text-ink-2" aria-hidden /> : <Folder size={14} className="shrink-0 text-ink-2" aria-hidden />}
            <span className="truncate">{n.name}</span>
          </button>
          {openDirs.has(n.path) && renderNodes(n.children, depth + 1)}
        </div>
      ) : (
        <button
          key={n.path}
          type="button"
          onClick={() => setSelected(n.path)}
          aria-current={n.path === current ? "true" : undefined}
          className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[13px] ${n.path === current ? "bg-primary-weak font-semibold text-primary" : "hover:bg-surface-2"}`}
          style={{ paddingLeft: 25 + depth * 12 }}
        >
          <FileText size={14} className="shrink-0 opacity-70" aria-hidden />
          <span className="truncate">{n.name}</span>
        </button>
      ),
    );

  return (
    <div className="pop mx-auto flex h-full max-w-[1280px] overflow-hidden bg-surface">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line">
        <label className="m-2 flex h-8 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-ink-3">
          <Search size={13} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a file" aria-label="Find a file" className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none" />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {files === null ? (
            <p className="px-2 text-[13px] text-ink-2">Loading files…</p>
          ) : matches ? (
            matches.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setSelected(f)}
                className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-xs ${f === current ? "bg-primary-weak text-primary" : "hover:bg-surface-2"}`}
              >
                {f}
              </button>
            ))
          ) : (
            renderNodes(tree, 0)
          )}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <span className="truncate font-mono text-xs">{file?.path ?? current ?? ""}</span>
          <span className="pill ml-auto">Read only</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {file?.note ? (
            <p className="p-4 text-ink-2">{file.note}</p>
          ) : (
            <CodeEditor
              value={file?.content ?? ""}
              language={languageForFile(file?.path ?? current ?? "")}
              readOnly
              minHeight={200}
              maxHeight={null}
              className="rounded-none border-0 focus-within:shadow-none"
              ariaLabel={`${file?.path ?? "File"} (read only)`}
            />
          )}
        </div>
      </section>
    </div>
  );
}
