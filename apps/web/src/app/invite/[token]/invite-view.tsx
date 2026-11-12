"use client";

import { Spinner } from "@/components/loading";
import type { InvitationPreview } from "@forge/protocol";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthLayout, Field } from "@/components/auth-layout";
import { api } from "@/lib/api";
import { signIn, signOut, signUp, useSession } from "@/lib/auth-client";

const ROLE: Record<string, string> = { admin: "an admin", builder: "a builder", member: "a member", viewer: "a viewer" };
const ACCESS: Record<string, string> = { admin: "admin", builder: "builder", viewer: "view" };

/** /invite/<token>: create an account (or sign in) and join. */
export function InviteView() {
  const { token } = useParams<{ token: string }>();
  const { data: session, isPending } = useSession();
  const [invite, setInvite] = useState<InvitationPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.invitation(token).then(setInvite, (e) => setProblem(e instanceof Error ? e.message : String(e)));
  }, [token]);

  const finish = (projectId: string | null) => window.location.assign(projectId ? `/projects/${projectId}` : "/");

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.acceptInvitation(token);
      finish(r.projectId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!invite) return;
    setBusy(true);
    setError(null);
    const res = invite.hasAccount
      ? await signIn.email({ email: invite.email, password })
      : await signUp.email({ email: invite.email, password, name });
    if (res.error) {
      setError(res.error.message ?? "Something went wrong");
      setBusy(false);
      return;
    }
    // New accounts get their roles at sign-up; existing accounts accept now.
    if (invite.hasAccount) await accept();
    else finish(null);
  }

  const signedInAsOther = session && invite && session.user.email.toLowerCase() !== invite.email;
  const signedInAsInvitee = session && invite && session.user.email.toLowerCase() === invite.email;

  return (
    <AuthLayout>
      {problem ? (
        <div className="flex flex-col gap-3">
          <h1 className="h1">This link doesn&apos;t work</h1>
          <p className="text-ink-2">{problem}</p>
          <a href="/login" className="btn">
            Go to sign in
          </a>
        </div>
      ) : !invite || isPending ? (
        <p className="text-ink-2">Loading your invitation…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="h1">Join Forge</h1>
            <p className="mt-1 leading-relaxed text-ink-2">
              <strong className="text-ink">{invite.invitedBy}</strong> invited <strong className="text-ink">{invite.email}</strong> to join as{" "}
              {ROLE[invite.role]}
              {invite.projectName && invite.projectRole ? (
                <>
                  , with {ACCESS[invite.projectRole]} access to <strong className="text-ink">{invite.projectName}</strong>
                </>
              ) : null}
              .
            </p>
          </div>

          {signedInAsOther ? (
            <>
              <p className="rounded-md bg-warn-weak px-3 py-2 text-sm text-warn">
                You&apos;re signed in as {session.user.email}. Sign out, then open this link again to accept it as {invite.email}.
              </p>
              <button type="button" className="btn" onClick={() => signOut().then(() => window.location.reload())}>
                Sign out
              </button>
            </>
          ) : signedInAsInvitee ? (
            <button type="button" className="btn btn-p h-10" disabled={busy} onClick={accept}>
              {(busy) && <Spinner size={13} />}
              {busy ? "Joining…" : "Accept invitation"}
            </button>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <Field label="Email" type="email" value={invite.email} readOnly />
              {!invite.hasAccount && <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />}
              <Field
                label={invite.hasAccount ? "Password" : "Choose a password (10+ characters)"}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={10}
                autoComplete={invite.hasAccount ? "current-password" : "new-password"}
              />
              <button type="submit" className="btn btn-p h-10" disabled={busy}>
                {busy ? "Please wait…" : invite.hasAccount ? "Sign in and join" : "Create account and join"}
              </button>
            </form>
          )}
          {error && (
            <p className="rounded-md bg-danger-weak px-3 py-2 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
