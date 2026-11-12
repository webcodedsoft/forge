"use client";

import { BusyLabel, SkeletonRows } from "@/components/loading";
import { Modal, ModalActions } from "@/components/modal";
import { OptionCard } from "@/components/option-card";
import type { Invitation, Project, ProjectRole, TeamMember, WorkspaceRole } from "@forge/protocol";
import {
  Ban,
  Check,
  Copy,
  Hammer,
  Link2,
  Mail,
  ShieldCheck,
  User,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "@/components/project-badge";
import { api } from "@/lib/api";
import { isAdmin, useMe } from "@/lib/me";
import { Pagination, usePagination } from "@/components/pagination";

const WS_ROLES: { id: WorkspaceRole; label: string; help: string }[] = [
  { id: "admin", label: "Admin", help: "Everything: people, API connections, team brain, usage, every project" },
  { id: "builder", label: "Builder", help: "Creates projects and builds in projects shared with them" },
  { id: "member", label: "Member", help: "Only the projects shared with them; can't create projects" },
];
const PROJECT_ROLES: { id: ProjectRole; label: string }[] = [
  { id: "admin", label: "Admin" },
  { id: "builder", label: "Builder" },
  { id: "viewer", label: "Viewer" },
];

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border border-primary bg-primary-weak p-2">
      <Link2 size={15} className="shrink-0 text-primary" aria-hidden />
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
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

/** Workspace admins: members, roles, invitations. */
export default function TeamPage() {
  const me = useMe();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const memberPager = usePagination(members, 15);
  const invitePager = usePagination(invites, 10);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [projectId, setProjectId] = useState("");
  const [projectRole, setProjectRole] = useState<ProjectRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [newLink, setNewLink] = useState<{ email: string; link: string } | null>(null);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(() => {
    api.team().then(
      (t) => {
        setMembers(t.members);
        setInvites(t.invitations);
      },
      (e) => setError(err(e)),
    );
  }, []);
  useEffect(() => {
    load();
    api.listProjects().then(setProjects, () => undefined);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(err(e));
    }
  };

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const inv = await api.invite({ email, role, ...(projectId ? { projectId, projectRole } : {}) });
      setNewLink({ email: inv.email, link: inv.link! });
      setEmail("");
      setProjectId("");
      load();
    } catch (e2) {
      setError(err(e2));
    } finally {
      setBusy(false);
    }
  }

  if (me && !isAdmin(me)) {
    return (
      <main className="px-5 py-6 sm:px-7">
        <h1 className="h1">Team</h1>
        <p className="mt-2 text-ink-2">Only workspace admins can manage the team.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="h1">Team</h1>
          <p className="mt-1 text-ink-2">Invite people, choose what they can do, and remove access.</p>
        </div>
        <button type="button" className="btn btn-p" onClick={() => setInviting(true)}>
          <UserPlus size={15} aria-hidden />
          Invite people
        </button>
      </div>
      {error && (
        <p className="rounded-md bg-danger-weak px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <Modal
        open={inviting}
        onClose={() => {
          setInviting(false);
          setNewLink(null);
        }}
        busy={busy}
        icon={<UserPlus size={19} aria-hidden />}
        title={newLink ? "Invitation ready" : "Invite people"}
        description={newLink ? undefined : "Forge doesn't send email yet: you get a link to send. It works once and expires in 7 days."}
      >
        {newLink ? (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-[13.5px]">
              <Check size={16} className="text-ok" aria-hidden />
              Send this link to <strong>{newLink.email}</strong>:
            </p>
            <CopyLink link={newLink.link} />
            <ModalActions>
              <button type="button" className="btn btn-g" onClick={() => setNewLink(null)}>
                Invite someone else
              </button>
              <button
                type="button"
                className="btn btn-p"
                onClick={() => {
                  setInviting(false);
                  setNewLink(null);
                }}
              >
                Done
              </button>
            </ModalActions>
          </div>
        ) : (
          <form onSubmit={invite} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="lab">Email</span>
              <input className="in" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoFocus />
            </label>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="lab mb-1.5">Team role</legend>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Team role">
                {WS_ROLES.map((r) => (
                  <OptionCard key={r.id} selected={role === r.id} onSelect={() => setRole(r.id)} title={r.label} text={r.help} />
                ))}
              </div>
            </fieldset>
            {role !== "admin" && (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <label className="flex flex-col gap-1.5">
                  <span className="lab">Also add to a project (optional)</span>
                  <select className="in" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    <option value="">No project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="lab">Project role</span>
                  <select className="in" value={projectRole} disabled={!projectId} onChange={(e) => setProjectRole(e.target.value as ProjectRole)}>
                    {PROJECT_ROLES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <ModalActions>
              <button type="button" className="btn btn-g" onClick={() => setInviting(false)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn btn-p" aria-busy={busy}>
                <BusyLabel busy={busy} busyText="Creating…">
                  <Link2 size={14} aria-hidden /> Create invite link
                </BusyLabel>
              </button>
            </ModalActions>
          </form>
        )}
      </Modal>

      {members && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Team at a glance">
          {(
            [
              ["Admins", members.filter((m) => m.role === "admin").length, ShieldCheck],
              ["Builders", members.filter((m) => m.role === "builder").length, Hammer],
              ["Members", members.filter((m) => m.role === "member").length, User],
              ["Pending invites", invites.length, Mail],
            ] as const
          ).map(([label, n, Icon]) => (
            <div key={label} className="tile flex items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-weak text-primary">
                <Icon size={18} aria-hidden />
              </div>
              <div>
                <p className="lab">{label}</p>
                <p className="big">{n}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="card overflow-hidden" aria-label="Members">
        <div className="flex items-center justify-between px-4 py-3.5">
          <h2 className="h2 flex items-center gap-2">
            <Users size={16} aria-hidden />
            Members
          </h2>
          <span className="lab">{members ? `${members.length} people` : ""}</span>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[620px]">
            <div className="th">
              <span className="flex-[2]">Person</span>
              <span className="w-36">Role</span>
              <span className="w-24">Projects</span>
              <span className="w-28">Joined</span>
              <span className="w-24" />
            </div>
            {members === null && <SkeletonRows n={4} avatar />}
            {memberPager.items.map((m) => (
              <div key={m.id} className="row">
                <span className="flex min-w-0 flex-[2] items-center gap-2.5">
                  <Avatar name={m.name} size={30} ring={false} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">
                      {m.name}
                      {m.id === me?.id && <span className="lab ml-1.5">(you)</span>}
                    </span>
                    <span className="lab block truncate">{m.email}</span>
                  </span>
                </span>
                <span className="w-36">
                  <select
                    className="in h-8 w-full py-0 text-[13px]"
                    aria-label={`Role of ${m.name}`}
                    value={m.role}
                    onChange={(e) => act(() => api.setMemberRole(m.id, e.target.value as WorkspaceRole))}
                  >
                    {WS_ROLES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </span>
                <span className="w-24 text-ink-2">{m.role === "admin" ? "All" : m.projects}</span>
                <span className="lab w-28">{new Date(m.joinedAt).toLocaleDateString()}</span>
                <span className="flex w-24 justify-end">
                  {m.id !== me?.id && (
                    <button type="button" className="btn btn-g btn-sm btn-danger" onClick={() => act(() => api.removeMember(m.id))}>
                      <UserMinus size={14} aria-hidden />
                      Remove
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
        <Pagination pager={memberPager} noun="people" className="border-t border-line px-4" />
      </section>

      <section className="card overflow-hidden" aria-label="Pending invitations">
        <div className="px-4 py-3.5">
          <h2 className="h2 flex items-center gap-2">
            <Mail size={16} aria-hidden />
            Pending invitations
          </h2>
        </div>
        {invites.length === 0 ? (
          <p className="px-4 pb-4 text-ink-2">No pending invitations.</p>
        ) : (
          invitePager.items.map((i) => (
            <div key={i.id} className="row">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{i.email}</span>
                <span className="lab block">
                  {WS_ROLES.find((r) => r.id === i.role)?.label}
                  {i.projectName ? ` · ${PROJECT_ROLES.find((r) => r.id === i.projectRole)?.label} in ${i.projectName}` : ""} · invited by {i.invitedBy} ·
                  expires {new Date(i.expiresAt).toLocaleDateString()}
                </span>
              </span>
              <button type="button" className="btn btn-g btn-sm btn-danger" onClick={() => act(() => api.revokeInvitation(i.id))}>
                <Ban size={14} aria-hidden />
                Revoke
              </button>
            </div>
          ))
        )}
        <Pagination pager={invitePager} noun="invitations" className="border-t border-line px-4" />
      </section>
    </main>
  );
}
