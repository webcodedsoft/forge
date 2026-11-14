import type { PreviewShare, PreviewShareDuration, SharedPreviewInfo } from "@forge/protocol";
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "./db/index.ts";
import { env } from "./env.ts";
import { previewUrl } from "./sandbox.ts";
import { decrypt, encrypt } from "./secrets.ts";

/*
 * Who may see a project's preview (preview.ts checks every request):
 *   team members   the builder fetches a short-lived entry link (/__forge/enter?t=…) for the
 *                  project it shows; opening it sets a pass cookie on that preview host.
 *   share links    /__forge/share/<token> lets anyone in until the link expires or is revoked.
 *                  The token is looked up by its hash; it is also kept encrypted (bound to the
 *                  project and link) so builders can copy the link again from the Share dialog.
 * The pass is a signed cookie, valid only on its project's preview host. Inside the builder's
 * iframe (a different site in local development) it's a partitioned cross-site cookie; opened
 * on its own it's a normal one.
 */

const KEY = Buffer.from(hkdfSync("sha256", env.BETTER_AUTH_SECRET, "forge", "preview-access-v1", 32));
export const PASS_COOKIE = "forge_preview";
/** How long a member's pass lasts before the builder fetches a new one. */
const MEMBER_PASS_MS = 12 * 60 * 60 * 1000;
const ENTER_TOKEN_MS = 5 * 60 * 1000;
const DURATION_MS: Record<PreviewShareDuration, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (data: string) => createHmac("sha256", KEY).update(data).digest("base64url");

function sign(payload: object): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
}
function verify<T>(token: string | undefined): T | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

/** The preview origin for a project (or its compare preview). */
export function previewOrigin(projectId: string, compare = false): string {
  const u = previewUrl(projectId);
  return new URL(compare ? u.replace(`//${projectId}.`, `//${projectId}--compare.`) : u).origin;
}

/** A one-time-ish link (5 minutes) that lets a team member into the preview. */
export function memberEnterUrl(projectId: string, userId: string, compare: boolean, next = "/"): string {
  const t = sign({ p: projectId, c: compare, u: userId, exp: Date.now() + ENTER_TOKEN_MS });
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return `${previewOrigin(projectId, compare)}/__forge/enter?t=${encodeURIComponent(t)}&next=${encodeURIComponent(safeNext)}`;
}

type EnterToken = { p: string; c: boolean; u: string; exp: number };
export type Pass = { p: string; k: "member" | "share"; s?: string; exp: number };

export const verifyEnterToken = (t: string | undefined) => verify<EnterToken>(t);
export const verifyPass = (v: string | undefined) => verify<Pass>(v);

/** The pass cookie for a preview host. `iframe`: requested inside another site's iframe. */
export function passCookie(pass: Pass, req: IncomingMessage): string {
  const maxAge = Math.max(1, Math.floor((pass.exp - Date.now()) / 1000));
  const crossSite = req.headers["sec-fetch-site"] === "cross-site";
  const base = `${PASS_COOKIE}=${sign(pass)}; Path=/; HttpOnly; Max-Age=${maxAge}`;
  // Inside the builder's iframe on another site, only a partitioned, Secure, SameSite=None cookie
  // is kept (browsers treat *.localhost as secure). Otherwise a plain first-party cookie.
  return crossSite ? `${base}; SameSite=None; Secure; Partitioned` : `${base}; SameSite=Lax`;
}

export function memberPass(projectId: string): Pass {
  return { p: projectId, k: "member", exp: Date.now() + MEMBER_PASS_MS };
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/* --------------------------------- share links -------------------------------- */

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

const shareUrl = (projectId: string, token: string) => `${new URL(env.BETTER_AUTH_URL).origin}/preview/${projectId}/${token}`;
const tokenAad = (projectId: string, shareId: string) => `preview-share/${projectId}/${shareId}`;

/** The link, when Forge kept its token (links made before that only have a hash). */
function storedUrl(r: typeof schema.previewShare.$inferSelect): string | undefined {
  if (!r.tokenEnc) return undefined;
  try {
    return shareUrl(r.projectId, decrypt(r.tokenEnc, tokenAad(r.projectId, r.id)));
  } catch {
    return undefined; // a different FORGE_SECRETS_KEY: the link still works, it just can't be shown
  }
}

const toShare = (r: typeof schema.previewShare.$inferSelect): PreviewShare => ({
  id: r.id,
  label: r.label,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
  revokedAt: r.revokedAt?.toISOString() ?? null,
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  uses: r.uses,
  allowFeedback: r.allowFeedback,
  url: storedUrl(r),
});

export async function createShare(
  projectId: string,
  duration: PreviewShareDuration,
  label: string | undefined,
  by: string,
  allowFeedback = true,
): Promise<PreviewShare> {
  const token = randomBytes(24).toString("base64url");
  const id = nanoid(10);
  const [row] = await db
    .insert(schema.previewShare)
    .values({
      id,
      projectId,
      tokenHash: hash(token),
      tokenEnc: encrypt(token, tokenAad(projectId, id)),
      label: label?.trim() || null,
      allowFeedback,
      createdBy: by,
      expiresAt: new Date(Date.now() + DURATION_MS[duration]),
    })
    .returning();
  // Shared as /preview/<projectId>/<token> on Forge's own address (index.ts), which leads to the
  // preview host's /__forge/share/<token>.
  return { ...toShare(row!), url: shareUrl(projectId, token) };
}

/** Links that still work (not expired or revoked), newest first. */
export async function listShares(projectId: string): Promise<PreviewShare[]> {
  const rows = await db
    .select()
    .from(schema.previewShare)
    .where(and(eq(schema.previewShare.projectId, projectId), isNull(schema.previewShare.revokedAt), sql`${schema.previewShare.expiresAt} > now()`))
    .orderBy(desc(schema.previewShare.createdAt));
  return rows.map(toShare);
}

export async function revokeShare(projectId: string, id: string): Promise<boolean> {
  const r = await db
    .update(schema.previewShare)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.previewShare.projectId, projectId), eq(schema.previewShare.id, id), isNull(schema.previewShare.revokedAt)))
    .returning({ id: schema.previewShare.id });
  if (r.length) shareCache.delete(id);
  return r.length > 0;
}

/** Opening a share link: its pass, or null when the link is wrong, expired or revoked. */
export async function passForShareToken(projectId: string, token: string): Promise<Pass | null> {
  const [row] = await db.select().from(schema.previewShare).where(eq(schema.previewShare.tokenHash, hash(token)));
  if (!row || row.projectId !== projectId || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
  await db
    .update(schema.previewShare)
    .set({ uses: sql`${schema.previewShare.uses} + 1`, lastUsedAt: new Date() })
    .where(eq(schema.previewShare.id, row.id));
  return { p: projectId, k: "share", s: row.id, exp: row.expiresAt.getTime() };
}

/** Whether a share pass's link still works (revoking cuts access right away; cached 15 s). */
const shareCache = new Map<string, { ok: boolean; at: number }>();
export async function shareStillValid(shareId: string): Promise<boolean> {
  const c = shareCache.get(shareId);
  if (c && Date.now() - c.at < 15_000) return c.ok;
  const [row] = await db
    .select({ revokedAt: schema.previewShare.revokedAt, expiresAt: schema.previewShare.expiresAt })
    .from(schema.previewShare)
    .where(eq(schema.previewShare.id, shareId));
  const ok = Boolean(row && !row.revokedAt && row.expiresAt.getTime() > Date.now());
  shareCache.set(shareId, { ok, at: Date.now() });
  return ok;
}

/**
 * The public share page (/preview/<projectId>/<token> in the web app) asks what a link opens:
 * the project's name, when the link expires, and the frame address. The use is counted when the
 * frame opens the link, not here.
 */
export async function describeShare(projectId: string, token: string): Promise<SharedPreviewInfo | null> {
  const [row] = await db
    .select({ share: schema.previewShare, name: schema.project.name })
    .from(schema.previewShare)
    .innerJoin(schema.project, eq(schema.project.id, schema.previewShare.projectId))
    .where(eq(schema.previewShare.tokenHash, hash(token)));
  if (!row || row.share.projectId !== projectId || row.share.revokedAt || row.share.expiresAt.getTime() <= Date.now()) return null;
  return {
    projectName: row.name,
    expiresAt: row.share.expiresAt.toISOString(),
    frameUrl: `${previewOrigin(projectId)}/__forge/share/${token}`,
    feedback: row.share.allowFeedback,
  };
}

/** A working share link by its token (for guest feedback), or null. */
export async function shareForToken(projectId: string, token: string): Promise<{ id: string; label: string | null; allowFeedback: boolean } | null> {
  const [row] = await db.select().from(schema.previewShare).where(eq(schema.previewShare.tokenHash, hash(token)));
  if (!row || row.projectId !== projectId || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
  return { id: row.id, label: row.label, allowFeedback: row.allowFeedback };
}
