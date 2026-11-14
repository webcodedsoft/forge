"use client";

import { BarChart3, Blocks, BookOpen, Database, FolderKanban, Library, LogOut, Plug, Users } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import { isAdmin, useMe } from "@/lib/me";
import { useOpenProjects } from "@/lib/open-projects";
import { CommandPalette } from "./command-palette";
import { ForgeMark } from "./forge-mark";
import { Avatar, ProjectBadge } from "./project-badge";
import { ThemeToggle } from "./theme-toggle";

const NAV = [
  { href: "/", label: "Projects", icon: FolderKanban, adminOnly: false },
  { href: "/settings/library", label: "Templates & library", icon: Library, adminOnly: false },
  { href: "/settings/brain", label: "Team brain", icon: BookOpen, adminOnly: false },
  { href: "/settings/apis", label: "API connections", icon: Plug, adminOnly: false },
  { href: "/settings/data", label: "Data sources", icon: Database, adminOnly: false },
  { href: "/settings/usage", label: "Usage", icon: BarChart3, adminOnly: true },
  { href: "/settings/team", label: "Team", icon: Users, adminOnly: true },
  { href: "/settings/integrations", label: "Integrations", icon: Blocks, adminOnly: true },
];

/** Top bar + left navigation for every page except the project builder. */
/**
 * The main links, with the current page marked (also for its details pages, e.g. /settings/apis/<id>).
 * Reading the URL makes this part dynamic, so it sits in its own Suspense boundary.
 */
function MainLinks({ admin, current }: { admin: boolean; current?: boolean }) {
  return (
    <>
      {NAV.filter((n) => !n.adminOnly || admin).map(({ href, label, icon: Icon }) =>
        current ? (
          <CurrentLink key={href} href={href} label={label} Icon={Icon} />
        ) : (
          <Link key={href} href={href} className="nav">
            <Icon size={16} aria-hidden />
            {label}
          </Link>
        ),
      )}
    </>
  );
}
function CurrentLink({ href, label, Icon }: { href: string; label: string; Icon: (typeof NAV)[number]["icon"] }) {
  const pathname = usePathname();
  const on = pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
  return (
    <Link href={href} className="nav" aria-current={on ? "page" : undefined}>
      <Icon size={16} aria-hidden />
      {label}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const open = useOpenProjects();
  const me = useMe();
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (!isPending && !session) router.replace("/login");
  }, [isPending, session, router]);

  // The page always renders (its own data calls handle sign-in); only the account menu waits.
  return (
    // Desktop: the frame fills the window; the header and sidebar stay put and only the content
    // scrolls. Phones: the sidebar sits above the content, so the page scrolls and the header sticks.
    <div className="flex min-h-dvh flex-col md:h-dvh md:min-h-0 md:overflow-hidden">
      <header className="sticky top-0 z-30 flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2.5 md:static">
        <Link href="/" className="flex items-center gap-2 text-base font-bold">
          <ForgeMark size={28} />
          Forge
        </Link>
        <div className="ml-3 flex flex-1">
          <CommandPalette />
        </div>
        <div className="relative ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setMenu((m) => !m)}
            aria-expanded={menu}
            aria-label="Your account"
            className="rounded-full"
            disabled={!session}
          >
            {session ? <Avatar name={session.user.name} size={32} ring={false} /> : <span className="block size-8 rounded-full bg-surface-2" />}
          </button>
          {menu && session && (
            <div className="pop absolute right-0 top-11 z-30 w-56 p-1.5">
              <p className="px-2.5 py-2">
                <span className="block font-semibold">{session.user.name}</span>
                <span className="block truncate text-xs text-ink-2">{session.user.email}</span>
                {me && <span className="pill pill-pri mt-1.5 capitalize">{me.role}</span>}
              </p>
              <button
                type="button"
                onClick={() => signOut().then(() => window.location.assign("/login"))}
                className="nav"
              >
                <LogOut size={15} aria-hidden />
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="Main" className="flex shrink-0 flex-col gap-0.5 border-line bg-surface p-3 md:w-56 md:overflow-y-auto md:border-r">
          <Suspense fallback={<MainLinks admin={isAdmin(me)} />}>
            <MainLinks admin={isAdmin(me)} current />
          </Suspense>
          {open.length > 0 && (
            <>
              <p className="lab mx-2.5 mb-1 mt-5">Open projects</p>
              {open.map((p) => (
                <Link key={p.id} href={`/projects/${p.id}`} className="nav">
                  <ProjectBadge id={p.id} name={p.name} size={18} />
                  <span className="truncate">{p.name}</span>
                </Link>
              ))}
            </>
          )}
        </nav>
        <div id="main-scroll" className="flex min-w-0 flex-1 flex-col md:min-h-0 md:overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
