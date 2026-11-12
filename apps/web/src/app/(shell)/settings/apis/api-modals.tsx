"use client";

import type { ApiConnection } from "@forge/protocol";
import { CheckCircle2, KeyRound, Plug, Upload } from "lucide-react";
import { useId, useState } from "react";
import { CodeEditor } from "@/components/code-editor";
import { BusyLabel } from "@/components/loading";
import { Modal, ModalActions } from "@/components/modal";
import { api } from "@/lib/api";
import { AuthFields, authLine, authProblem, detectAuth, draftFrom, emptyAuth, toAuthInput, type AuthDraft } from "./auth-fields";

/* Modals for API connections: add one, change its sign-in, replace an uploaded spec. */

/* ------------------------------ spec picking ----------------------------- */

type SpecDraft = { mode: "url" | "file" | "paste"; url: string; text: string; fileName: string };

/** URL, uploaded file or pasted text. Calls onParsed with the JSON document when it can read it (to pre-fill). */
function SpecSource({ draft, onChange, onParsed, allowUrl = true }: { draft: SpecDraft; onChange: (d: SpecDraft) => void; onParsed?: (spec: unknown) => void; allowUrl?: boolean }) {
  const fileId = useId();
  const read = (text: string, fileName: string) => {
    onChange({ ...draft, mode: draft.mode, text, fileName });
    try {
      if (text.trimStart().startsWith("{")) onParsed?.(JSON.parse(text));
    } catch {
      /* the server reports parse errors */
    }
  };
  const tabs = [...(allowUrl ? [["url", "From a URL"] as const] : []), ["file", "Upload a file"] as const, ["paste", "Paste"] as const];
  return (
    <div className="flex flex-col gap-2.5">
      <span className="lab">OpenAPI spec (3.x, JSON or YAML)</span>
      <div className="seg self-start" role="radiogroup" aria-label="Where the spec comes from">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={draft.mode === id} className="mode" onClick={() => onChange({ ...draft, mode: id })}>
            {label}
          </button>
        ))}
      </div>
      {draft.mode === "url" ? (
        <input className="in" type="url" placeholder="https://api.yourcompany.com/openapi.json" value={draft.url} onChange={(e) => onChange({ ...draft, url: e.target.value })} aria-label="Spec URL" />
      ) : draft.mode === "file" ? (
        <label
          htmlFor={fileId}
          className="flex cursor-pointer flex-col items-center gap-1.5 rounded-[10px] border-2 border-dashed border-line-2 px-6 py-6 text-center transition-colors hover:border-primary hover:bg-primary-weak/40"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) void f.text().then((t) => read(t, f.name));
          }}
        >
          {draft.text ? <CheckCircle2 size={22} className="text-ok" aria-hidden /> : <Upload size={22} className="text-primary" aria-hidden />}
          <span className="font-semibold">{draft.text ? draft.fileName : "Drop the spec here, or choose a file"}</span>
          <span className="lab">.json, .yaml or .yml, up to 10 MB</span>
          <input
            id={fileId}
            type="file"
            accept=".json,.yaml,.yml,application/json"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then((t) => read(t, f.name));
            }}
          />
        </label>
      ) : (
        <CodeEditor
          language={draft.text.trimStart().startsWith("{") || !draft.text.trim() ? "json" : "yaml"}
          value={draft.text}
          onChange={(v) => read(v, "pasted.json")}
          placeholder='{ "openapi": "3.0.0", "info": { … }, "paths": { … } }'
          minHeight={180}
          maxHeight={360}
          ariaLabel="Spec (JSON or YAML)"
        />
      )}
    </div>
  );
}

const specReady = (d: SpecDraft) => (d.mode === "url" ? Boolean(d.url.trim()) : Boolean(d.text.trim()));

/* ------------------------------- the modals ------------------------------ */

export function AddApiModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [spec, setSpec] = useState<SpecDraft>({ mode: "url", url: "", text: "", fileName: "" });
  const [auth, setAuth] = useState<AuthDraft>(emptyAuth("none"));
  const [detected, setDetected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opening again starts fresh.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setBaseUrl("");
      setSpec({ mode: "url", url: "", text: "", fileName: "" });
      setAuth(emptyAuth("none"));
      setDetected(null);
      setError(null);
    }
  }

  // A JSON spec tells us the server address and how it signs in.
  function onParsed(doc: unknown) {
    const d = doc as { servers?: { url?: string }[]; info?: { title?: string } };
    const server = d.servers?.find((s) => s.url && /^https?:\/\//.test(s.url))?.url;
    if (server && !baseUrl) setBaseUrl(server);
    if (!name && d.info?.title) setName(d.info.title.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 20));
    const found = detectAuth(doc);
    if (found) {
      setAuth((a) => ({ ...a, ...found }));
      setDetected("The spec says how it signs in; that's pre-selected below. Add the credentials.");
    }
  }

  async function submit() {
    const problem = authProblem(auth);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api.createConnection({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        ...(spec.mode === "url" ? { specUrl: spec.url.trim() } : { specText: spec.text, specFileName: spec.fileName || "spec.json" }),
        auth: toAuthInput(auth),
      });
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} busy={busy} size="lg" icon={<Plug size={19} aria-hidden />} title="Add an API" description="From its OpenAPI spec. Forge signs every call, so apps never hold the credentials.">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SpecSource draft={spec} onChange={setSpec} onParsed={onParsed} />
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <label className="flex flex-col gap-1.5">
            <span className="lab">Name in code</span>
            <input
              className="in font-mono"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""))}
              placeholder="hr"
              pattern="[a-z][a-z0-9]{1,30}"
              title="Lowercase letters and numbers, starting with a letter"
              required
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lab">Base URL (where calls go)</span>
            <input className="in" type="url" placeholder="https://api.yourcompany.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
          </label>
        </div>
        <div className="flex flex-col gap-2 rounded-[10px] border border-line p-4">
          {detected && (
            <p className="flex items-start gap-2 text-[13px] text-ok" role="status">
              <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden />
              {detected}
            </p>
          )}
          <AuthFields draft={auth} onChange={setAuth} />
        </div>
        {error && (
          <p className="rounded-md bg-danger-weak px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        <ModalActions>
          <button type="button" className="btn btn-g" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-p" aria-busy={busy} disabled={!name || !baseUrl || !specReady(spec)}>
            <BusyLabel busy={busy} busyText={spec.mode === "url" ? "Reading the spec…" : "Adding…"}>
              Add API
            </BusyLabel>
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}

export function SignInModal({ connection, onClose, onSaved }: { connection: ApiConnection; onClose: () => void; onSaved: () => void }) {
  const [auth, setAuth] = useState<AuthDraft>(draftFrom(connection.auth));
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sameKind = auth.kind === connection.auth.kind;

  async function submit() {
    // Secrets aren't sent back to the page; with the same kind, empty secret fields keep what's saved.
    const keepSecret =
      sameKind &&
      ((auth.kind === "api_key" && !auth.value) ||
        (auth.kind === "bearer" && !auth.token) ||
        (auth.kind === "oauth2_client" && !auth.clientSecret) ||
        (auth.kind === "basic" && !auth.password) ||
        (auth.kind === "login" && !auth.password));
    const settingsChanged =
      !sameKind ||
      (auth.kind === "api_key" && connection.auth.kind === "api_key" && (auth.location !== connection.auth.location || auth.keyName !== connection.auth.name)) ||
      (auth.kind === "basic" && connection.auth.kind === "basic" && auth.username !== connection.auth.username) ||
      (auth.kind === "oauth2_client" &&
        connection.auth.kind === "oauth2_client" &&
        (auth.tokenUrl !== connection.auth.tokenUrl || auth.clientId !== connection.auth.clientId || auth.scope !== (connection.auth.scope ?? "") || auth.clientAuth !== connection.auth.clientAuth)) ||
      (auth.kind === "entra_user" && connection.auth.kind === "entra_user" && auth.entraScope !== (connection.auth.scope ?? "")) ||
      (auth.kind === "login" &&
        connection.auth.kind === "login" &&
        (auth.loginUrl !== connection.auth.loginUrl ||
          auth.username !== connection.auth.username ||
          auth.usernameField !== connection.auth.usernameField ||
          auth.passwordField !== connection.auth.passwordField ||
          auth.bodyFormat !== connection.auth.bodyFormat ||
          auth.tokenPath !== connection.auth.tokenPath ||
          auth.headerName !== connection.auth.headerName ||
          auth.prefix !== connection.auth.prefix));
    if (keepSecret && settingsChanged && auth.kind !== "basic") return setError("Enter the secret again to change these settings.");
    const problem = keepSecret ? null : authProblem(auth);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api.updateConnection(connection.id, {
        ...(baseUrl.trim() !== connection.baseUrl ? { baseUrl: baseUrl.trim() } : {}),
        ...(keepSecret && !settingsChanged ? {} : { auth: toAuthInput(auth) }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} busy={busy} icon={<KeyRound size={19} aria-hidden />} title={`Sign-in for ${connection.title || connection.name}`} description={`Now: ${authLine(connection.auth)}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="lab">Base URL</span>
          <input className="in" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
        </label>
        <AuthFields draft={auth} onChange={setAuth} editing={sameKind} />
        {error && (
          <p className="rounded-md bg-danger-weak px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        <ModalActions left="Test the connection after saving.">
          <button type="button" className="btn btn-g" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-p" aria-busy={busy}>
            <BusyLabel busy={busy}>Save</BusyLabel>
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}

export function ReplaceSpecModal({ connection, onClose, onSaved }: { connection: ApiConnection; onClose: () => void; onSaved: () => void }) {
  const [spec, setSpec] = useState<SpecDraft>({ mode: "file", url: "", text: "", fileName: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} busy={busy} icon={<Upload size={19} aria-hidden />} title={`Replace the spec of ${connection.title || connection.name}`} description="Projects using this API get the new endpoints and types right away.">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.updateConnection(connection.id, { specText: spec.text, specFileName: spec.fileName || "spec.json" });
            onSaved();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <SpecSource draft={spec} onChange={setSpec} allowUrl={false} />
        {error && (
          <p className="rounded-md bg-danger-weak px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        <ModalActions>
          <button type="button" className="btn btn-g" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-p" aria-busy={busy} disabled={!specReady(spec)}>
            <BusyLabel busy={busy}>Replace spec</BusyLabel>
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
