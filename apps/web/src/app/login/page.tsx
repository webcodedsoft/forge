"use client";

import { BusyLabel } from "@/components/loading";
import { useEffect, useState } from "react";
import { AuthLayout, Field } from "@/components/auth-layout";
import { signIn, signUp } from "@/lib/auth-client";

/**
 * Sign in. Accounts are created from an invitation link (/invite/<token>); the only
 * exception is the very first account, which becomes the workspace admin.
 */
export default function LoginPage() {
  const [firstUser, setFirstUser] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetch("/api/setup")
      .then((r) => r.json())
      .then((s: { needsFirstUser?: boolean }) => setFirstUser(Boolean(s.needsFirstUser)))
      .catch(() => undefined);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const res = firstUser ? await signUp.email({ email, password, name }) : await signIn.email({ email, password });
    setPending(false);
    if (res.error) {
      setError(res.error.message ?? "Something went wrong");
      return;
    }
    // Full navigation so every view reads the new session cookie fresh.
    window.location.assign("/");
  }

  return (
    <AuthLayout>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div>
          <h1 className="h1">{firstUser ? "Set up Forge" : "Sign in"}</h1>
          <p className="mt-1 text-ink-2">
            {firstUser ? "Create the first account. It becomes the workspace admin." : "Welcome back to your team workspace."}
          </p>
        </div>
        {firstUser && <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />}
        <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={10}
          autoComplete={firstUser ? "new-password" : "current-password"}
        />
        {error && (
          <p className="rounded-md bg-danger-weak px-3 py-2 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending} aria-busy={pending} className="btn btn-p h-10 w-full">
          <BusyLabel busy={pending} busyText={firstUser ? "Creating your account…" : "Signing in…"}>
            {firstUser ? "Create admin account" : "Sign in"}
          </BusyLabel>
        </button>
        {!firstUser && <p className="text-center text-[13px] text-ink-2">New to the team? Ask a workspace admin for an invite link.</p>}
      </form>
    </AuthLayout>
  );
}
