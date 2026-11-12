"use client";

import type { LibraryComponent, ProjectTemplate } from "@forge/protocol";
import { Code2, Component, LayoutTemplate, Trash2, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CodeEditor, languageForFile } from "@/components/code-editor";
import { BusyLabel, SkeletonCards } from "@/components/loading";
import { Pagination, usePagination } from "@/components/pagination";
import { ApiError, api } from "@/lib/api";
import { isAdmin, useMe } from "@/lib/me";

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Team templates (starting points for new projects) and the reusable component library. */
export default function LibraryPage() {
  const admin = isAdmin(useMe());
  const router = useRouter();
  const [templates, setTemplates] = useState<ProjectTemplate[] | null>(null);
  const [components, setComponents] = useState<LibraryComponent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"templates" | "components">("templates");
  const [openComponent, setOpenComponent] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const templatePager = usePagination(templates, 8);
  const componentPager = usePagination(components, 8);

  useEffect(() => {
    const fail = (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) router.replace("/login");
      else setError(e instanceof Error ? e.message : String(e));
    };
    api.listTemplates().then(setTemplates, fail);
    api.listLibrary().then(setComponents, fail);
  }, [router]);

  async function remove(kind: "template" | "component", id: string) {
    setBusy(id);
    try {
      if (kind === "template") {
        await api.deleteTemplate(id);
        setTemplates((t) => t?.filter((x) => x.id !== id) ?? null);
      } else {
        await api.deleteComponent(id);
        setComponents((c) => c?.filter((x) => x.id !== id) ?? null);
      }
      setConfirm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const deleteControls = (kind: "template" | "component", id: string, label: string) =>
    !admin ? null : confirm === id ? (
      <span className="flex shrink-0 gap-1.5">
        <button type="button" className="btn btn-g btn-sm" onClick={() => setConfirm(null)}>
          Keep
        </button>
        <button type="button" className="btn btn-sm btn-danger" aria-busy={busy === id} onClick={() => void remove(kind, id)}>
          <BusyLabel busy={busy === id}>Delete</BusyLabel>
        </button>
      </span>
    ) : (
      <button type="button" className="btn btn-g btn-sm btn-icon shrink-0" aria-label={`Delete ${label}`} onClick={() => setConfirm(id)}>
        <Trash2 size={14} aria-hidden />
      </button>
    );

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="h1">Templates &amp; library</h1>
      <p className="mt-1 max-w-2xl text-ink-2">What the team builds once and reuses: starting points for new projects, and components every project&apos;s agent can use.</p>

      {error && (
        <p className="mt-4 flex items-start gap-2 rounded-[10px] bg-danger-weak px-3.5 py-2.5 text-danger" role="alert">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">{error}</span>
          <button type="button" className="btn btn-g btn-sm btn-icon" aria-label="Dismiss" onClick={() => setError(null)}>
            <X size={14} aria-hidden />
          </button>
        </p>
      )}

      <div className="seg mt-6 self-start" role="tablist" aria-label="Library">
        <button role="tab" aria-selected={view === "templates"} className="mode" onClick={() => setView("templates")}>
          <LayoutTemplate size={14} aria-hidden />
          Project templates
          {templates && <span className="pill text-[11px]">{templates.length}</span>}
        </button>
        <button role="tab" aria-selected={view === "components"} className="mode" onClick={() => setView("components")}>
          <Component size={14} aria-hidden />
          Components
          {components && <span className="pill text-[11px]">{components.length}</span>}
        </button>
      </div>

      {view === "templates" ? (
        <section className="mt-4 flex flex-col gap-3" aria-label="Project templates">
          <p className="lab">Save one from any project&apos;s Versions tab; pick it under &ldquo;Starting point&rdquo; when creating a project.</p>
          {templates === null ? (
            <SkeletonCards n={3} />
          ) : templates.length === 0 ? (
            <Empty icon={<LayoutTemplate size={22} aria-hidden />} title="No templates yet" text="Open a project, go to Versions, and choose “Save as template”." />
          ) : (
            templatePager.items.map((t) => (
              <article key={t.id} className="card fade-in flex items-start gap-3 p-4">
                <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-weak text-primary">
                  <LayoutTemplate size={19} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="h2">{t.name}</h2>
                  {t.description && <p className="mt-0.5 text-ink-2">{t.description}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="pill">
                      From {t.sourceProjectName ?? "a deleted project"} · <code className="font-mono">{t.sourceSha.slice(0, 7)}</code>
                    </span>
                    <span className="pill">{kb(t.sizeBytes)}</span>
                    {t.apis.length > 0 && <span className="pill pill-pri">APIs: {t.apis.join(", ")}</span>}
                    {t.notes > 0 && <span className="pill">{t.notes} note{t.notes === 1 ? "" : "s"}</span>}
                    {t.secretNames.length > 0 && <span className="pill pill-warn">Needs secrets: {t.secretNames.join(", ")}</span>}
                  </div>
                  <p className="lab mt-2">
                    Saved by {t.createdBy}, {new Date(t.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {deleteControls("template", t.id, `template ${t.name}`)}
              </article>
            ))
          )}
          <Pagination pager={templatePager} noun="templates" />
        </section>
      ) : (
        <section className="mt-4 flex flex-col gap-3" aria-label="Component library">
          <p className="lab">
            To add one, select an element in a project&apos;s preview and choose &ldquo;Save to library&rdquo;, or ask the agent to save a component.
          </p>
          {components === null ? (
            <SkeletonCards n={3} />
          ) : components.length === 0 ? (
            <Empty icon={<Component size={22} aria-hidden />} title="No components yet" text="Select an element in any project's preview and choose “Save to library”." />
          ) : (
            componentPager.items.map((c) => (
              <article key={c.id} className="card fade-in flex flex-col gap-3 p-4">
                <div className="flex items-start gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-weak text-primary">
                    <Component size={19} aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="h2">{c.title}</h2>
                      <code className="pill pill-pri font-mono">{c.name}</code>
                    </div>
                    <p className="mt-0.5 text-ink-2">{c.description}</p>
                    <p className="lab mt-2">
                      {c.files.length} file{c.files.length === 1 ? "" : "s"}
                      {c.dependencies.length ? ` · needs ${c.dependencies.join(", ")}` : ""} · from {c.sourceProjectName ?? "a deleted project"} · saved by{" "}
                      {c.createdBy}, {new Date(c.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm shrink-0"
                    onClick={() => setOpenComponent((o) => (o === c.id ? null : c.id))}
                    aria-expanded={openComponent === c.id}
                  >
                    <Code2 size={13} aria-hidden />
                    {openComponent === c.id ? "Hide code" : "View code"}
                  </button>
                  {deleteControls("component", c.id, `component ${c.title}`)}
                </div>
                {openComponent === c.id && (
                  <div className="fade-in flex flex-col gap-3">
                    <div>
                      <p className="lab">Usage</p>
                      <CodeEditor className="mt-1" value={c.usage} language="tsx" readOnly lineNumbers={false} minHeight={40} maxHeight={240} ariaLabel={`How to use ${c.title}`} />
                    </div>
                    {c.files.map((f) => (
                      <div key={f.path}>
                        <p className="font-mono text-xs font-semibold">{f.path}</p>
                        <CodeEditor className="mt-1" value={f.content} language={languageForFile(f.path)} readOnly minHeight={60} maxHeight={360} ariaLabel={f.path} />
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))
          )}
          <Pagination pager={componentPager} noun="components" />
        </section>
      )}
    </main>
  );
}

function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="grid size-12 place-items-center rounded-xl bg-primary-weak text-primary">{icon}</div>
      <p className="font-semibold">{title}</p>
      <p className="max-w-md text-ink-2">{text}</p>
    </div>
  );
}
