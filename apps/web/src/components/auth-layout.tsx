import { Bot, MessageSquare, ShieldCheck } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";

/** Two-column layout for sign-in and invitation pages: brand panel + form card. */
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)]">
      <section className="dots relative hidden flex-col justify-between border-r border-line p-10 lg:flex">
        <div className="flex items-center gap-2 text-lg font-bold">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm text-primary-fg">F</span>
          Forge
        </div>
        <div className="max-w-lg">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">Describe an app. Forge builds it on our APIs and tests it before you see it.</h2>
          <ul className="mt-8 flex flex-col gap-4 text-ink-2">
            <li className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-weak text-primary">
                <Bot size={16} aria-hidden />
              </span>
              <span>
                <strong className="block text-ink">An agent that follows our rules</strong>
                The team brain keeps every app on our design system and coding standards.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-weak text-primary">
                <ShieldCheck size={16} aria-hidden />
              </span>
              <span>
                <strong className="block text-ink">Only working versions are saved</strong>
                Type checks, lint and a browser test run before every save.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-weak text-primary">
                <MessageSquare size={16} aria-hidden />
              </span>
              <span>
                <strong className="block text-ink">Built together</strong>
                See who&apos;s in a project, comment on any part of the app, and hand comments to the agent.
              </span>
            </li>
          </ul>
        </div>
        <p className="lab">Private to our team</p>
      </section>
      <section className="relative flex items-center justify-center bg-surface px-5 py-10">
        <div className="absolute right-4 top-4">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 text-lg font-bold lg:hidden">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm text-primary-fg">F</span>
            Forge
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}

/** A labelled input in the auth forms. */
export function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="lab">{label}</span>
      <input className="in h-10" {...props} />
    </label>
  );
}
