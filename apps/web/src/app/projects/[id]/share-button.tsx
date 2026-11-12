"use client";

import type { Invitation, ProjectMemberInfo, ProjectRole } from "@forge/protocol";
import { Check, Copy, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/project-badge";
import { api } from "@/lib/api";

const ROLES: { id: ProjectRole; label: string; help: string }[] = [
  { id: "admin", label: "Admin", help: "Everything, including who has access" },
  { id: "builder", label: "Builder", help: "Asks the agent for changes, restores versions, edits settings" },
  { id: "viewer", label: "Viewer", help: "Sees the app, chat and versions, and comments" },
];

type Data = {
  members: ProjectMemberInfo[];
  others: { userId: string; name: string; email: string }[];
  invitations: Invitation[];
  myRole: ProjectRole;
};

/** Header button + popover: who has access to this project, and (for project admins) managing it. */
export function ShareButton({ projectId, onError }: { projectId: string; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [addUser, setAddUser] = useState("");
  const [addRole, setAddRole] = useState<ProjectRole>("builder");
  const [email, setEmail] = useState("");
  const [emailRole, setEmailRole] = useState<ProjectRole>("viewer");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api.projectMembers(projectId).then(setData, (e) => onError(e instanceof Error ? e.message : String(e)));
  }, [projectId, onError]);

  useEffect(() => {
    if (!open) return;
    load();
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const closeOnBlur = () => setTimeout(() => document.activeElement?.tagName === "IFRAME" && setOpen(false), 0);
    document.addEventListener("mousedown", close);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [open, load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      load();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  const isAdmin = data?.myRole === "admin";

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="btn btn-sm">
        <Users size={14} aria-hidden />
        Share
      </button>
      {open && (
        <div className="pop absolute right-0 top-10 z-30 flex w-[400px] max-w-[calc(100vw-2rem)] flex-col gap-3 p-4">
          <div>
            <p className="h2">Who has access</p>
            <p className="text-xs text-ink-2">Workspace admins can always open every project.</p>
          </div>
          <div className="flex max-h-64 flex-col overflow-y-auto">
            {(data?.members ?? []).map((m) => (
              <div key={m.userId} className="flex items-center gap-2.5 py-1.5">
                <Avatar name={m.name} size={28} ring={false} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{m.name}</span>
                  <span className="lab block truncate">{m.viaWorkspaceAdmin ? "Workspace admin" : m.email}</span>
                </span>
                {isAdmin && !m.viaWorkspaceAdmin ? (
                  <>
                    <select
                      aria-label={`Role of ${m.name}`}
                      className="in h-8 py-0 text-[13px]"
                      value={m.role}
                      onChange={(e) => act(() => api.setProjectMember(projectId, m.userId, e.target.value as ProjectRole))}
                    >
                      {ROLES.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-g btn-sm btn-danger"
                      aria-label={`Remove ${m.name}`}
                      onClick={() => act(() => api.removeProjectMember(projectId, m.userId))}
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <span className="pill capitalize">{m.role}</span>
                )}
              </div>
            ))}
            {(data?.invitations ?? []).map((i) => (
              <div key={i.id} className="flex items-center gap-2.5 py-1.5">
                <span className="flex size-7 items-center justify-center rounded-full border border-dashed border-line-2 text-ink-3">@</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{i.email}</span>
                  <span className="lab">Invited, not joined yet</span>
                </span>
                <span className="pill capitalize">{i.projectRole}</span>
              </div>
            ))}
          </div>

          {isAdmin && (
            <>
              {data && data.others.length > 0 && (
                <form
                  className="flex flex-col gap-2 border-t border-line pt-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (addUser) void act(() => api.setProjectMember(projectId, addUser, addRole)).then(() => setAddUser(""));
                  }}
                >
                  <span className="lab">Add a teammate</span>
                  <div className="flex gap-2">
                    <select aria-label="Teammate" className="in min-w-0 flex-1" value={addUser} onChange={(e) => setAddUser(e.target.value)}>
                      <option value="">Choose…</option>
                      {data.others.map((o) => (
                        <option key={o.userId} value={o.userId}>
                          {o.name} ({o.email})
                        </option>
                      ))}
                    </select>
                    <select aria-label="Role" className="in" value={addRole} onChange={(e) => setAddRole(e.target.value as ProjectRole)}>
                      {ROLES.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                    <button className="btn btn-p" disabled={!addUser}>
                      Add
                    </button>
                  </div>
                </form>
              )}
              <form
                className="flex flex-col gap-2 border-t border-line pt-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    const r = await api.inviteToProject(projectId, email, emailRole);
                    setLink("link" in r && r.link ? r.link : null);
                    setEmail("");
                    load();
                  } catch (err) {
                    onError(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                <span className="lab">Invite someone new by email</span>
                <div className="flex gap-2">
                  <input aria-label="Email" type="email" required className="in min-w-0 flex-1" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                  <select aria-label="Role" className="in" value={emailRole} onChange={(e) => setEmailRole(e.target.value as ProjectRole)}>
                    {ROLES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn-p">Invite</button>
                </div>
                <span className="text-xs text-ink-2">{ROLES.find((r) => r.id === emailRole)?.help}. They join the team as a member.</span>
                {link && (
                  <div className="flex items-center gap-2 rounded-md border border-primary bg-primary-weak p-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs">{link}</code>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        await navigator.clipboard.writeText(link).catch(() => undefined);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                    >
                      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                )}
              </form>
            </>
          )}
        </div>
      )}
    </div>
  );
}
