import type { SecurityFinding, SecurityReport } from "@forge/protocol";
import { eq } from "drizzle-orm";
import { db, schema } from "./db/index.ts";
import { publish } from "./events.ts";
import { ensureSandbox, exec } from "./sandbox.ts";

/*
 * Checks before pushing to GitHub. Four kinds, all without the AI:
 *   dependencies  known vulnerabilities in installed packages (pnpm audit; needs the npm registry)
 *   secrets       keys, tokens and private keys in tracked files; committed .env files
 *   access        server routes and actions that change data without checking who is signed in
 *   input         request data used without validation, raw HTML, eval, SQL built from strings
 *
 * The code checks are deliberately simple pattern checks over the files git tracks. They point
 * at places to look at, so each finding has a "Fix" that asks the agent to judge and repair it.
 * Critical and high findings block pushing to GitHub.
 */

/** Runs inside the project container over `git ls-files`; prints SecurityFinding[] as JSON. */
const SCAN_SCRIPT = String.raw`
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
const files = execFileSync("git", ["ls-files", "-z"], { cwd: "/workspace", maxBuffer: 64 * 1024 * 1024 })
  .toString("utf8").split("\0").filter(Boolean)
  .filter((f) => !f.startsWith(".forge/") && !/(^|\/)(node_modules|\.next|dist|build)\//.test(f));
const findings = [];
const add = (f) => findings.push(f);
const CODE = /\.(m?[jt]sx?|cjs)$/;
const SKIP = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|pdf|zip)$/i;

// Committed environment files (examples are fine).
for (const f of files) {
  if (/(^|\/)\.env(\.[\w-]+)?$/.test(f) && !/\.(example|sample|template)$/.test(f)) {
    add({ category: "secrets", severity: "high", title: "An environment file is in the code", file: f, line: null,
      detail: "Files like .env usually hold passwords and keys. Anyone with the repository can read them.",
      fix: "Remove it from git, add it to .gitignore, and keep the values in Forge's Secrets." });
  }
}

const SECRET_PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, "A private key", "critical"],
  [/\bAKIA[0-9A-Z]{16}\b/, "An AWS access key", "critical"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "A GitHub token", "critical"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/, "A Slack token", "critical"],
  [/\bsk_live_[A-Za-z0-9]{16,}\b/, "A live Stripe key", "critical"],
  [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{30,}\b/, "An AI service API key", "critical"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "A Google API key", "high"],
  [/\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, "A signed token (JWT)", "high"],
  [/(?:api[_-]?key|secret|passw(?:or)?d|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i, "A hard-coded password or key", "high"],
];

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

for (const f of files) {
  if (SKIP.test(f)) continue;
  let text;
  try {
    if (statSync("/workspace/" + f).size > 512 * 1024) continue;
    text = readFileSync("/workspace/" + f, "utf8");
  } catch (_) { continue; }
  if (text.includes("\u0000")) continue;
  const isExample = /\.(example|sample|template)$|(^|\/)(test|tests|__tests__|e2e)\//.test(f);

  for (const [re, what, severity] of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const value = m[0];
    // Placeholders and env lookups aren't secrets.
    if (/process\.env|import\.meta\.env|your[_-]|xxxx|example|placeholder|changeme|<[^>]+>/i.test(value)) continue;
    add({ category: "secrets", severity: isExample ? "medium" : severity, title: what + " is written in the code", file: f, line: lineOf(text, m.index),
      detail: "Anyone who can read the repository can use it. Treat it as leaked: replace it with a new one.",
      fix: "Move it to Forge's Secrets (read it from process.env), and rotate the old value." });
  }

  if (!CODE.test(f)) continue;

  // Server entry points: route handlers and server actions.
  const isRoute = /(^|\/)app\/.*\/route\.[jt]s$/.test(f) || /(^|\/)pages\/api\//.test(f);
  const isAction = /^\s*["']use server["']/m.test(text);
  if (isRoute || isAction) {
    const writes = isAction || /export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\b/.test(text) || /req\.method\s*===?\s*["'](POST|PUT|PATCH|DELETE)/.test(text);
    const checksUser = /\b(auth|getSession|getServerSession|currentUser|requireUser|getUser|verifyToken|session)\s*\(|x-forge-access-token|authorization/i.test(text);
    if (writes && !checksUser) {
      add({ category: "access", severity: "medium", title: (isAction ? "A server action" : "An API route") + " changes data without checking who is signed in", file: f, line: null,
        detail: "Anyone who can reach the app could call it directly, not only through the page.",
        fix: "Check the signed-in user (and their permission) before changing anything, or explain why it's safe to be public." });
    }
    const readsInput = /\b(req|request)\.(json|formData|text)\(\)|searchParams\.get\(|\bformData\.get\(|req\.body\b|req\.query\b/.test(text);
    const validates = /\.(safeParse|parse|parseAsync)\(|\bz\.\w+\(|\byup\.|\bvalibot\b|\bjoi\.|validate\w*\(/.test(text);
    if (readsInput && !validates) {
      add({ category: "input", severity: "medium", title: "Request data is used without being checked", file: f, line: null,
        detail: "Values from the request go straight into the logic. Wrong types, huge values or unexpected fields can break it or be abused.",
        fix: "Validate the input (for example with a zod schema) and reject anything else with a clear error." });
    }
  }

  const rules = [
    [/dangerouslySetInnerHTML/, "high", "Raw HTML is inserted into the page", "If any of it comes from users, it can run scripts in other people's browsers.", "Render it as text, or sanitize it (for example with DOMPurify) first.", (t) => !/DOMPurify|sanitize/i.test(t)],
    [/\beval\s*\(|new\s+Function\s*\(/, "high", "Code is built and run from text (eval)", "If the text can come from a user, they can run any code.", "Replace eval/new Function with normal code.", null],
    [/\x60[^\x60]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^\x60]*\$\{|["']\s*(SELECT|INSERT|UPDATE|DELETE)\b[^"']*["']\s*\+/i, "high", "A database query is built from text", "Values pasted into SQL can change the query (SQL injection).", "Use parameters or the query builder instead of putting values into the SQL text.", null],
    [/\b(exec|execSync)\s*\(\s*\x60[^\x60]*\$\{/, "high", "A shell command is built from text", "Values pasted into a command can run other commands.", "Use execFile with an argument list, and validate the values.", null],
  ];
  for (const [re, severity, title, detail, fix, when] of rules) {
    const m = re.exec(text);
    if (m && (!when || when(text))) add({ category: "input", severity, title, file: f, line: lineOf(text, m.index), detail, fix });
  }
}
process.stdout.write(JSON.stringify(findings.slice(0, 200)));
`;

type Audit = { advisories?: Record<string, AuditAdvisory>; error?: { summary?: string } };
type AuditAdvisory = { module_name: string; severity: string; title: string; url: string; patched_versions?: string; findings?: { version: string }[] };

/** pnpm audit, as findings. Null when it couldn't run (no registry access, no lockfile). */
type RawFinding = Omit<SecurityFinding, "id">;

async function auditFindings(projectId: string): Promise<RawFinding[] | null> {
  const r = await exec(projectId, ["sh", "-c", "[ -f pnpm-lock.yaml ] || exit 3; timeout 60 pnpm audit --json --prod 2>/dev/null"]);
  if (r.exitCode === 3 || !r.stdout.trim().startsWith("{")) return null;
  let parsed: Audit;
  try {
    parsed = JSON.parse(r.stdout) as Audit;
  } catch {
    return null;
  }
  if (!parsed.advisories) return null;
  const rank: Record<string, SecurityFinding["severity"]> = { critical: "critical", high: "high", moderate: "medium", low: "low", info: "low" };
  return Object.values(parsed.advisories).map((a) => ({
    category: "dependencies" as const,
    severity: rank[a.severity] ?? "medium",
    title: `${a.module_name}: ${a.title}`,
    file: "package.json",
    line: null,
    detail: `Installed: ${[...new Set((a.findings ?? []).map((f) => f.version))].join(", ") || "?"}. Details: ${a.url}`,
    fix: a.patched_versions && a.patched_versions !== "<0.0.0" ? `Update ${a.module_name} to ${a.patched_versions}.` : `Replace ${a.module_name} or remove it; no fixed version is published.`,
  }));
}

const running = new Map<string, Promise<SecurityReport>>();

/** Scan the app as it is now, store the report (latest only) and tell open builders. */
export function scanProject(projectId: string): Promise<SecurityReport> {
  const busy = running.get(projectId);
  if (busy) return busy;
  const p = (async () => {
    await ensureSandbox(projectId);
    const [code, audit, sha] = await Promise.all([
      exec(projectId, ["node", "--input-type=module", "-e", SCAN_SCRIPT]),
      auditFindings(projectId).catch(() => null),
      exec(projectId, ["git", "rev-parse", "HEAD"]),
    ]);
    let findings: RawFinding[];
    try {
      findings = JSON.parse(code.stdout.trim()) as RawFinding[];
    } catch {
      throw new Error(`The security scan couldn't run: ${(code.stderr || code.stdout).trim().slice(-300)}`);
    }
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    const all = [...(audit ?? []), ...findings]
      .sort((a, b) => order[a.severity] - order[b.severity])
      .map((f, i) => ({ ...f, id: `f${i + 1}` }));
    const report: SecurityReport = {
      sha: sha.stdout.trim() || null,
      at: new Date().toISOString(),
      findings: all,
      dependenciesChecked: audit !== null,
      blocking: all.filter((f) => f.severity === "critical" || f.severity === "high").length,
    };
    await db
      .insert(schema.securityScan)
      .values({ projectId, report })
      .onConflictDoUpdate({ target: schema.securityScan.projectId, set: { report, at: new Date() } });
    publish(projectId, { type: "security_changed", projectId });
    return report;
  })().finally(() => running.delete(projectId));
  running.set(projectId, p);
  return p;
}

export async function latestScan(projectId: string): Promise<SecurityReport | null> {
  const [row] = await db.select().from(schema.securityScan).where(eq(schema.securityScan.projectId, projectId));
  return (row?.report as SecurityReport | undefined) ?? null;
}

/** The request the agent gets for "Fix" (one finding) or "Fix all". */
export function securityFixPrompt(findings: SecurityFinding[]): string {
  return [
    findings.length === 1
      ? "Forge's security check before pushing to GitHub found this. Look at it, fix it if it's a real problem, and say so if it's a false alarm:"
      : `Forge's security check before pushing to GitHub found these ${findings.length} things. Look at each, fix the real problems, and say which are false alarms:`,
    ...findings.map(
      (f, i) =>
        `${findings.length > 1 ? `${i + 1}. ` : ""}[${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}\n${f.detail}\nSuggested fix: ${f.fix}`,
    ),
    "Never paste secret values into the code or this chat. Secrets belong in Forge's Secrets (read via process.env).",
  ].join("\n\n");
}
