"use client";

import {
  Brain,
  ChevronDown,
  Database,
  GitBranch,
  Globe,
  Hammer,
  HeartPulse,
  History,
  KeyRound,
  Keyboard,
  LayoutDashboard,
  Library,
  LifeBuoy,
  type LucideIcon,
  MessageSquare,
  MessagesSquare,
  MousePointerClick,
  Palette,
  Paperclip,
  Plug,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { type Article, CATEGORIES, FAQ, SHORTCUTS } from "./help-content";

const ICONS: Record<string, LucideIcon> = {
  Brain,
  Database,
  GitBranch,
  Globe,
  Hammer,
  HeartPulse,
  History,
  KeyRound,
  LayoutDashboard,
  Library,
  MessageSquare,
  MessagesSquare,
  MousePointerClick,
  Palette,
  Paperclip,
  Plug,
  Rocket,
  ShieldCheck,
  Sparkles,
  Users,
};
const Icon = ({ name, size = 16 }: { name: string; size?: number }) => {
  const I = ICONS[name] ?? Sparkles;
  return <I size={size} aria-hidden />;
};

const QUICK_START = [
  { n: 1, title: "Describe it", text: "Say what the app is for, who uses it and what they need to do." },
  { n: 2, title: "Review it", text: "Click through the preview, comment, and ask for changes." },
  { n: 3, title: "Share it", text: "Every passing change is a saved version. Share the project or push it to GitHub." },
];

const text = (a: Article) => [a.title, a.summary, ...(a.steps ?? []), ...(a.body ?? []), a.tip ?? ""].join(" ").toLowerCase();

/** The built-in help center: search, quick start, categories of articles, shortcuts and FAQ. */
export default function HelpPage() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(["first-app"]));
  const q = query.trim().toLowerCase();

  const results = useMemo(
    () =>
      CATEGORIES.map((c) => ({ ...c, articles: q ? c.articles.filter((a) => q.split(/\s+/).every((w) => text(a).includes(w))) : c.articles })).filter(
        (c) => c.articles.length,
      ),
    [q],
  );
  const count = results.reduce((n, c) => n + c.articles.length, 0);
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <main className="fade-in mx-auto w-full max-w-6xl flex-1 px-4 pb-16 sm:px-6">
      {/* Hero */}
      <section className="relative -mx-4 mb-8 overflow-hidden border-b border-line px-4 pb-10 pt-10 sm:-mx-6 sm:px-6">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{ background: "radial-gradient(ellipse 60% 80% at 15% 0%, var(--primary-weak), transparent 70%)" }}
          aria-hidden
        />
        <div className="relative max-w-2xl">
          <p className="flex items-center gap-2 text-[12.5px] font-semibold uppercase tracking-wide text-primary">
            <LifeBuoy size={14} aria-hidden />
            Help center
          </p>
          <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight">How can we help?</h1>
          <p className="mt-2 text-[15px] text-ink-2">Guides for building, reviewing and sharing apps in Forge.</p>
          <label className="mt-6 flex h-12 items-center gap-3 rounded-xl border border-line-2 bg-surface px-4 shadow-sm focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--primary-ring)]">
            <Search size={18} className="shrink-0 text-ink-3" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search help, e.g. “attach a file” or “restore a version”"
              aria-label="Search help"
              className="menu-search h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-3"
            />
            {query && (
              <button type="button" className="btn btn-g btn-icon btn-sm" aria-label="Clear search" onClick={() => setQuery("")}>
                <X size={15} aria-hidden />
              </button>
            )}
          </label>
          {q && (
            <p className="mt-2 text-[13px] text-ink-3" role="status">
              {count} article{count === 1 ? "" : "s"} found
            </p>
          )}
        </div>
      </section>

      {/* Quick start */}
      {!q && (
        <section aria-labelledby="qs" className="mb-10">
          <h2 id="qs" className="h2 mb-3">
            Quick start
          </h2>
          <ol className="grid gap-3 sm:grid-cols-3">
            {QUICK_START.map((s) => (
              <li key={s.n} className="card flex gap-3 p-4">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-[13px] font-bold text-primary-fg">{s.n}</span>
                <span>
                  <span className="block font-semibold">{s.title}</span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-2">{s.text}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="grid gap-10 lg:grid-cols-[15.5rem_minmax(0,1fr)]">
        {/* Contents */}
        <nav aria-label="Help topics" className="hidden lg:block">
          <div className="sticky top-6 flex flex-col gap-0.5">
            <p className="lab mb-2 px-2.5">Topics</p>
            {results.map((c) => (
              <a key={c.id} href={`#${c.id}`} className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-ink-2 hover:bg-surface-2 hover:text-ink">
                <Icon name={c.icon} size={15} />
                <span className="flex-1 truncate">{c.title}</span>
                <span className="text-[11.5px] text-ink-3">{c.articles.length}</span>
              </a>
            ))}
            {!q && (
              <>
                <a href="#shortcuts" className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-ink-2 hover:bg-surface-2 hover:text-ink">
                  <Keyboard size={15} aria-hidden />
                  Keyboard shortcuts
                </a>
                <a href="#faq" className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-ink-2 hover:bg-surface-2 hover:text-ink">
                  <MessageSquare size={15} aria-hidden />
                  Questions
                </a>
              </>
            )}
          </div>
        </nav>

        <div className="flex min-w-0 flex-col gap-10">
          {results.length === 0 && (
            <div className="card flex flex-col items-center gap-2 p-10 text-center">
              <Search size={22} className="text-ink-3" aria-hidden />
              <p className="font-semibold">No articles match “{query.trim()}”</p>
              <p className="text-[13px] text-ink-2">Try other words, or ask the agent in Chat mode: it knows your project.</p>
            </div>
          )}

          {results.map((c) => (
            <section key={c.id} id={c.id} aria-labelledby={`${c.id}-h`} className="scroll-mt-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-lg bg-primary-weak text-primary">
                  <Icon name={c.icon} size={17} />
                </span>
                <div>
                  <h2 id={`${c.id}-h`} className="h2">
                    {c.title}
                  </h2>
                  <p className="text-[13px] text-ink-3">{c.blurb}</p>
                </div>
              </div>
              <div className="card divide-y divide-line overflow-hidden">
                {c.articles.map((a) => {
                  const isOpen = Boolean(q) || open.has(a.id);
                  return (
                    <article key={a.id} id={a.id} className="scroll-mt-6">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={`${a.id}-body`}
                        onClick={() => toggle(a.id)}
                        className="flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-surface-2/60"
                      >
                        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-line bg-surface-2 text-ink-2">
                          <Icon name={a.icon} size={14} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14.5px] font-semibold">{a.title}</span>
                          <span className="block text-[13px] text-ink-2">{a.summary}</span>
                        </span>
                        <ChevronDown size={16} className={`mt-1 shrink-0 text-ink-3 transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden />
                      </button>
                      {isOpen && (
                        <div id={`${a.id}-body`} className="px-4 pb-4 pl-14 text-[13.5px] leading-relaxed text-ink-2">
                          {a.steps && (
                            <ol className="flex flex-col gap-2">
                              {a.steps.map((s, i) => (
                                <li key={s} className="flex gap-2.5">
                                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary-weak text-[11px] font-bold text-primary">{i + 1}</span>
                                  <span>{s}</span>
                                </li>
                              ))}
                            </ol>
                          )}
                          {a.body?.map((b) => (
                            <p key={b} className="mt-2 first:mt-0">
                              {b}
                            </p>
                          ))}
                          {a.tip && (
                            <p className="mt-3 flex gap-2 rounded-lg border border-primary/20 bg-primary-weak/50 px-3 py-2 text-[13px] text-ink">
                              <Sparkles size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                              {a.tip}
                            </p>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          ))}

          {!q && (
            <>
              <section id="shortcuts" aria-labelledby="sc-h" className="scroll-mt-6">
                <h2 id="sc-h" className="h2 mb-3 flex items-center gap-2">
                  <Keyboard size={17} className="text-primary" aria-hidden />
                  Keyboard shortcuts
                </h2>
                <div className="card divide-y divide-line">
                  {SHORTCUTS.map((s) => (
                    <div key={s.what} className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13.5px]">
                      <span className="text-ink-2">{s.what}</span>
                      <span className="flex shrink-0 gap-1">
                        {s.keys.map((k) => (
                          <kbd key={k} className="min-w-7 rounded-md border border-line-2 bg-surface-2 px-1.5 py-0.5 text-center font-mono text-[12px] text-ink shadow-[0_1px_0_var(--line-2)]">
                            {k}
                          </kbd>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <section id="faq" aria-labelledby="faq-h" className="scroll-mt-6">
                <h2 id="faq-h" className="h2 mb-3 flex items-center gap-2">
                  <MessageSquare size={17} className="text-primary" aria-hidden />
                  Common questions
                </h2>
                <div className="card divide-y divide-line overflow-hidden">
                  {FAQ.map((f) => (
                    <details key={f.q} className="group">
                      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-[14px] font-medium hover:bg-surface-2/60">
                        <span className="flex-1">{f.q}</span>
                        <ChevronDown size={16} className="shrink-0 text-ink-3 transition-transform group-open:rotate-180" aria-hidden />
                      </summary>
                      <p className="px-4 pb-4 text-[13.5px] leading-relaxed text-ink-2">{f.a}</p>
                    </details>
                  ))}
                </div>
              </section>

              <section className="card flex flex-col items-start gap-3 bg-[linear-gradient(135deg,var(--primary-weak),transparent)] p-5 sm:flex-row sm:items-center">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-fg">
                  <LifeBuoy size={19} aria-hidden />
                </span>
                <div className="flex-1">
                  <p className="font-semibold">Still stuck?</p>
                  <p className="text-[13px] text-ink-2">
                    Ask the agent in Chat mode: it can explain anything about your project. For access or settings, contact a workspace admin.
                  </p>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
