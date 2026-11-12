import type { CreateDataSourceInput, DataSource, DataSourceDetails, DataSourceKind, DataSourceTable, UpdateDataSourceInput } from "@forge/protocol";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { and, count, eq, inArray } from "drizzle-orm";
import ExcelJS from "exceljs";
import mssql from "mssql";
import mysql from "mysql2/promise";
import { customAlphabet } from "nanoid";
import postgres from "postgres";
import { handleGateway } from "./api-gateway.ts";
import { db, schema } from "./db/index.ts";
import { env } from "./env.ts";
import { activeRunId, RunConflictError } from "./runs.ts";
import { ensureSandbox, exec, putFiles } from "./sandbox.ts";
import { decrypt, encrypt } from "./secrets.ts";

/*
 * Company data sources: read-only data that apps build on.
 *
 *   postgres / mssql / mysql   a database the admin registers (ideally with a read-only login)
 *   sheet                      an uploaded Excel or CSV file, kept as a read-only SQLite file
 *   flowkite                   a Flowkite Database API key: its read operations (not SQL), called on
 *                              Flowkite's Data Gateway; operations that change data are left out
 *
 * Apps never get credentials. Their dev server gets FORGE_DATA_URL and a per-project
 * FORGE_DATA_TOKEN; the generated helper src/lib/forge-data.ts posts { source, sql, params } to
 * the data proxy here, which checks the project may use that source and runs the query:
 *   - one statement, SELECT or WITH only
 *   - in a read-only transaction (Postgres, MySQL), with read-only intent (SQL Server; plus no
 *     write keywords, since SQL Server has no read-only transactions), or on a read-only file
 *   - 15 s timeout, at most 2,000 rows back
 */

export class DataSourceError extends Error {}

const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);
const DATASETS_DIR = resolve(fileURLToPath(new URL("../../../data/datasets", import.meta.url)));
const MAX_ROWS = 2000;
const TIMEOUT_MS = 15_000;
const MAX_SHEET_ROWS = 200_000;

type DbConfig = { host: string; port?: number; database: string; user: string; ssl: boolean };
type SheetConfig = { fileName: string };
type FlowkiteConfig = { gatewayUrl: string; database: string };
type Row = typeof schema.dataSource.$inferSelect;

const AAD = (id: string) => `datasource/${id}`;
const KIND_LABEL: Record<DataSourceKind, string> = { postgres: "PostgreSQL", mssql: "SQL Server", mysql: "MySQL", sheet: "Spreadsheet", flowkite: "Flowkite" };
const PLACEHOLDERS: Record<DataSourceKind, string> = { postgres: "$1, $2, …", mysql: "?", sheet: "?", mssql: "@p1, @p2, …", flowkite: "" };

/* -------------------------------- Flowkite ------------------------------- */

const flowkiteKey = (row: Row) => (row.secret ? (JSON.parse(decrypt(row.secret, AAD(row.id))) as { apiKey: string }).apiKey : "");
const flowkiteBase = (c: FlowkiteConfig) => `${c.gatewayUrl.replace(/\/+$/, "")}/v1/ext/sources/${encodeURIComponent(c.database)}`;

type FkSchema = { type?: string; properties?: Record<string, FkSchema>; items?: FkSchema; format?: string };
type FkOperation = {
  summary?: string;
  "x-writes"?: boolean;
  "x-paused"?: boolean;
  requestBody?: { content?: { "application/json"?: { schema?: FkSchema } } };
  responses?: Record<string, { content?: { "application/json"?: { schema?: FkSchema } } }>;
};

/** The key's read operations, from Flowkite's OpenAPI description of that key. */
async function flowkiteOperations(row: Row): Promise<DataSourceTable[]> {
  const c = row.config as FlowkiteConfig;
  const res = await fetch(`${flowkiteBase(c)}/openapi.json`, {
    headers: { authorization: `Bearer ${flowkiteKey(row)}`, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  }).catch((e: Error) => {
    throw new DataSourceError(`Couldn't reach the Flowkite gateway: ${e.message}`);
  });
  if (res.status === 401) throw new DataSourceError("Flowkite refused the API key (wrong, expired or revoked).");
  if (res.status === 404) throw new DataSourceError(`Flowkite doesn't know the database "${c.database}".`);
  if (!res.ok) throw new DataSourceError(`The Flowkite gateway answered ${res.status}.`);
  const doc = (await res.json()) as { paths?: Record<string, { post?: FkOperation }> };
  const tables: DataSourceTable[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const op = item.post;
    const name = /\/operations\/([^/]+)$/.exec(path)?.[1];
    // Read-only, like every data source: operations that change data are left out.
    if (!op || !name || op["x-writes"] || op["x-paused"]) continue;
    const row = op.responses?.["200"]?.content?.["application/json"]?.schema?.properties?.rows?.items;
    const inputs = Object.keys(op.requestBody?.content?.["application/json"]?.schema?.properties ?? {});
    tables.push({
      schema: "operation",
      name: decodeURIComponent(name),
      summary: op.summary,
      inputs,
      columns: Object.entries(row?.properties ?? {}).map(([n, s]) => ({ name: n, type: s.format ?? s.type ?? "value" })),
    });
  }
  return tables;
}

export type OperationResult = { rows: Record<string, unknown>[]; nextPage?: string | null; truncated?: boolean };

/** Call one of a Flowkite source's read operations. */
async function callFlowkite(row: Row, operation: string, body: unknown): Promise<OperationResult> {
  const op = (row.tables as DataSourceTable[]).find((t) => t.name === operation);
  if (!op) throw new DataSourceError(`"${operation}" isn't one of this source's read operations. Refresh the source if it was added in Flowkite recently.`);
  const res = await fetch(`${flowkiteBase(row.config as FlowkiteConfig)}/operations/${encodeURIComponent(operation)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${flowkiteKey(row)}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(TIMEOUT_MS + 5000),
  }).catch((e: Error) => {
    throw new DataSourceError(`Couldn't reach the Flowkite gateway: ${e.message}`);
  });
  const json = (await res.json().catch(() => ({}))) as OperationResult & { error?: { code?: string; message?: string } };
  if (!res.ok) throw new DataSourceError(`Flowkite: ${json.error?.message ?? `answered ${res.status}`}${json.error?.code ? ` (${json.error.code})` : ""}`);
  return { rows: Array.isArray(json.rows) ? json.rows.slice(0, MAX_ROWS) : [], nextPage: json.nextPage ?? null, truncated: Boolean(json.truncated) };
}

/** Run a Flowkite source's operation for a project (data proxy) or an admin (preview). */
export async function runOperation(sourceRow: Row, operation: string, body: unknown) {
  if (sourceRow.kind !== "flowkite") throw new DataSourceError("Operations are for Flowkite sources; use query() for databases and spreadsheets.");
  return callFlowkite(sourceRow, operation, body);
}

/* ------------------------------ connections ------------------------------ */

type Client =
  | { kind: "postgres"; sql: ReturnType<typeof postgres> }
  | { kind: "mysql"; pool: mysql.Pool }
  | { kind: "mssql"; pool: mssql.ConnectionPool }
  | { kind: "sheet"; db: DatabaseSync };

const clients = new Map<string, Client>();

async function openClient(id: string, kind: DataSourceKind, config: DbConfig | SheetConfig, password: string | null): Promise<Client> {
  if (kind === "flowkite") throw new DataSourceError("Flowkite sources have no database connection.");
  if (kind === "sheet") {
    const file = join(DATASETS_DIR, `${id}.sqlite`);
    if (!existsSync(file)) throw new DataSourceError("The spreadsheet's data file is missing. Upload it again.");
    return { kind, db: new DatabaseSync(file, { readOnly: true }) };
  }
  const c = config as DbConfig;
  if (kind === "postgres") {
    return {
      kind,
      sql: postgres({ host: c.host, port: c.port ?? 5432, database: c.database, username: c.user, password: password ?? "", ssl: c.ssl ? "require" : false, max: 3, idle_timeout: 60, connect_timeout: 10 }),
    };
  }
  if (kind === "mysql") {
    return {
      kind,
      pool: mysql.createPool({ host: c.host, port: c.port ?? 3306, database: c.database, user: c.user, password: password ?? "", ssl: c.ssl ? {} : undefined, connectionLimit: 3, connectTimeout: 10_000 }),
    };
  }
  const pool = new mssql.ConnectionPool({
    server: c.host,
    port: c.port ?? 1433,
    database: c.database,
    user: c.user,
    password: password ?? "",
    connectionTimeout: 10_000,
    requestTimeout: TIMEOUT_MS,
    pool: { max: 3, idleTimeoutMillis: 60_000 },
    // Internal servers often use the company's own certificate authority.
    options: { encrypt: c.ssl, trustServerCertificate: true, readOnlyIntent: true },
  });
  await pool.connect();
  return { kind, pool };
}

async function clientFor(row: Row): Promise<Client> {
  const cached = clients.get(row.id);
  if (cached) return cached;
  const password = row.secret ? (JSON.parse(decrypt(row.secret, AAD(row.id))) as { password: string }).password : null;
  const c = await openClient(row.id, row.kind as DataSourceKind, row.config as DbConfig | SheetConfig, password);
  clients.set(row.id, c);
  return c;
}

async function closeClient(id: string) {
  const c = clients.get(id);
  clients.delete(id);
  if (!c) return;
  if (c.kind === "postgres") await c.sql.end({ timeout: 2 }).catch(() => undefined);
  else if (c.kind === "mysql") await c.pool.end().catch(() => undefined);
  else if (c.kind === "mssql") await c.pool.close().catch(() => undefined);
  else c.db.close();
}

/* -------------------------------- queries -------------------------------- */

/** One read-only statement, or an explanation of why not. */
export function checkQuery(kind: DataSourceKind, text: string): string {
  const s = text
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");
  if (!s) throw new DataSourceError("The query is empty.");
  if (s.includes(";")) throw new DataSourceError("Send one statement at a time (and pass values as parameters, not inside the SQL).");
  if (!/^(select|with)\b/i.test(s)) throw new DataSourceError("Data sources are read-only: only SELECT (or WITH … SELECT) queries run.");
  if (kind === "mssql" && /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec|execute|into|openrowset|opendatasource)\b/i.test(s)) {
    throw new DataSourceError("Data sources are read-only: this query contains a statement that changes data.");
  }
  return s;
}

export type QueryResult = { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean };

const plain = (v: unknown): unknown => (typeof v === "bigint" ? Number(v) : v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? `<${v.length} bytes>` : v);
const cap = (rows: Record<string, unknown>[], columns: string[]): QueryResult => ({
  columns,
  rows: rows.slice(0, MAX_ROWS).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)]))),
  truncated: rows.length > MAX_ROWS,
});

async function run(row: Row, text: string, params: unknown[]): Promise<QueryResult> {
  const kind = row.kind as DataSourceKind;
  if (kind === "flowkite") throw new DataSourceError("Flowkite sources run operations, not SQL: use callOperation().");
  const sqlText = checkQuery(kind, text);
  const c = await clientFor(row);
  try {
    if (c.kind === "postgres") {
      const rows = await c.sql.begin("read only", async (tx) => {
        await tx.unsafe(`set local statement_timeout = ${TIMEOUT_MS}`);
        return tx.unsafe(sqlText, params as never[]);
      });
      return cap(rows as unknown as Record<string, unknown>[], (rows as unknown as { columns?: { name: string }[] }).columns?.map((x) => x.name) ?? []);
    }
    if (c.kind === "mysql") {
      const conn = await c.pool.getConnection();
      try {
        await conn.query("START TRANSACTION READ ONLY");
        const [rows, fields] = await conn.query({ sql: sqlText, timeout: TIMEOUT_MS }, params);
        return cap(rows as Record<string, unknown>[], (fields ?? []).map((f) => f.name));
      } finally {
        await conn.query("ROLLBACK").catch(() => undefined);
        conn.release();
      }
    }
    if (c.kind === "mssql") {
      const req = c.pool.request();
      params.forEach((v, i) => req.input(`p${i + 1}`, v as never));
      const r = await req.query(sqlText);
      return cap(r.recordset as Record<string, unknown>[], Object.keys(r.recordset?.columns ?? {}));
    }
    const stmt = c.db.prepare(sqlText);
    const rows: Record<string, unknown>[] = [];
    for (const r of stmt.iterate(...(params as never[]))) {
      rows.push(r as Record<string, unknown>);
      if (rows.length > MAX_ROWS) break;
    }
    return cap(rows, stmt.columns().map((x) => x.name));
  } catch (err) {
    if (err instanceof DataSourceError) throw err;
    if (/read-only transaction|read only transaction/i.test(String((err as Error).message))) {
      throw new DataSourceError("Data sources are read-only: this query tries to change data.");
    }
    // A broken connection: drop it so the next query reconnects.
    if (/ECONN|closed|terminat|timeout/i.test(String((err as Error).message))) await closeClient(row.id);
    throw new DataSourceError(String((err as Error).message).split("\n")[0]!.slice(0, 400));
  }
}

/* ------------------------------- structure ------------------------------- */

async function introspect(row: Row): Promise<DataSourceTable[]> {
  const kind = row.kind as DataSourceKind;
  if (kind === "flowkite") return flowkiteOperations(row);
  const c = await clientFor(row);
  const group = (cols: { s: string | null; t: string; c: string; ty: string }[]): DataSourceTable[] => {
    const map = new Map<string, DataSourceTable>();
    for (const x of cols) {
      const key = `${x.s ?? ""}.${x.t}`;
      if (!map.has(key)) map.set(key, { schema: x.s, name: x.t, columns: [] });
      map.get(key)!.columns.push({ name: x.c, type: x.ty });
    }
    return [...map.values()].slice(0, 300);
  };
  if (c.kind === "sheet") {
    const tables = c.db.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[];
    return tables.map((t) => ({
      schema: null,
      name: t.name,
      columns: (c.db.prepare(`pragma table_info("${t.name.replace(/"/g, '""')}")`).all() as { name: string; type: string }[]).map((x) => ({ name: x.name, type: x.type.toLowerCase() || "text" })),
      rows: Number((c.db.prepare(`select count(*) as n from "${t.name.replace(/"/g, '""')}"`).get() as { n: number }).n),
    }));
  }
  const q =
    kind === "postgres"
      ? "select table_schema as s, table_name as t, column_name as c, data_type as ty from information_schema.columns where table_schema not in ('pg_catalog','information_schema') order by table_schema, table_name, ordinal_position limit 5000"
      : kind === "mysql"
        ? "select table_schema as s, table_name as t, column_name as c, data_type as ty from information_schema.columns where table_schema = database() order by table_name, ordinal_position limit 5000"
        : "select top 5000 table_schema as s, table_name as t, column_name as c, data_type as ty from information_schema.columns order by table_schema, table_name, ordinal_position";
  const r = await run(row, q, []);
  return group(r.rows.map((x) => ({ s: String(x.s ?? x.S ?? "") || null, t: String(x.t ?? x.T), c: String(x.c ?? x.C), ty: String(x.ty ?? x.TY ?? "") })));
}

/* ------------------------------ spreadsheets ----------------------------- */

const ident = (s: string, fallback: string) => {
  const v = s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  return !v ? fallback : /^\d/.test(v) ? `t_${v}` : v;
};
const unique = (names: string[]) => {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = seen.get(n) ?? 0;
    seen.set(n, k + 1);
    return k ? `${n}_${k + 1}` : n;
  });
};

/** A cell as a plain value (formulas → their result, rich text → text, dates → ISO). */
function cellValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object") {
    const o = v as { result?: unknown; richText?: { text: string }[]; text?: string; error?: string };
    if ("result" in o) return cellValue(o.result);
    if (o.richText) return o.richText.map((x) => x.text).join("");
    if (typeof o.text === "string") return o.text;
    if (o.error) return null;
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** RFC 4180-ish CSV (quotes, escaped quotes, commas/semicolons/tabs). */
function parseCsv(text: string): string[][] {
  const first = text.split("\n", 1)[0] ?? "";
  const delim = [",", ";", "\t"].sort((a, b) => first.split(b).length - first.split(a).length)[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Sheets as { name, rows } (first non-empty row = headers). */
async function readSpreadsheet(fileName: string, data: Buffer): Promise<{ name: string; rows: (string | number | null)[][] }[]> {
  if (/\.csv$/i.test(fileName)) {
    const rows = parseCsv(data.toString("utf8").replace(/^﻿/, "")).map((r) => r.map((c) => cellValue(c)));
    return [{ name: fileName.replace(/\.csv$/i, ""), rows }];
  }
  if (!/\.xlsx$/i.test(fileName)) throw new DataSourceError("Upload an Excel file (.xlsx) or a CSV file.");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw new DataSourceError("That file couldn't be read as an Excel workbook.");
  }
  return wb.worksheets.map((ws) => {
    const rows: (string | number | null)[][] = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const values = (r.values as unknown[]).slice(1).map(cellValue);
      if (values.some((v) => v !== null)) rows.push(values);
    });
    return { name: ws.name, rows };
  });
}

async function buildSheetDatabase(id: string, fileName: string, data: Buffer) {
  const sheets = (await readSpreadsheet(fileName, data)).filter((s) => s.rows.length > 1);
  if (!sheets.length) throw new DataSourceError("The file has no sheet with a header row and data.");
  mkdirSync(DATASETS_DIR, { recursive: true });
  const file = join(DATASETS_DIR, `${id}.sqlite`);
  rmSync(file, { force: true });
  const out = new DatabaseSync(file);
  try {
    const tableNames = unique(sheets.map((s, i) => ident(s.name, `sheet_${i + 1}`)));
    sheets.forEach((sheet, si) => {
      const [header, ...body] = sheet.rows;
      const width = Math.max(...sheet.rows.map((r) => r.length));
      const cols = unique(Array.from({ length: width }, (_, i) => ident(String(header![i] ?? ""), `column_${i + 1}`)));
      // A column is a number if every non-empty value is one.
      const types = cols.map((_, i) => {
        const vals = body.map((r) => r[i]).filter((v) => v !== null && v !== undefined && v !== "");
        if (vals.length && vals.every((v) => (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^-?\d+$/.test(v)))) return "integer";
        if (vals.length && vals.every((v) => typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)))) return "real";
        return "text";
      });
      const t = `"${tableNames[si]!}"`;
      out.exec(`create table ${t} (${cols.map((c, i) => `"${c}" ${types[i]}`).join(", ")})`);
      const ins = out.prepare(`insert into ${t} values (${cols.map(() => "?").join(", ")})`);
      out.exec("begin");
      for (const r of body.slice(0, MAX_SHEET_ROWS)) {
        ins.run(
          ...cols.map((_, i) => {
            const v = r[i] ?? null;
            if (v === null) return null;
            return types[i] === "text" ? String(v) : Number(v);
          }),
        );
      }
      out.exec("commit");
    });
  } finally {
    out.close();
  }
}

/* ---------------------------------- CRUD --------------------------------- */

function toApi(r: Row, projects: number): DataSource {
  const c = r.config as DbConfig & SheetConfig;
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    kind: r.kind as DataSourceKind,
    where:
      r.kind === "sheet"
        ? c.fileName
        : r.kind === "flowkite"
          ? `${new URL((r.config as FlowkiteConfig).gatewayUrl).host} / ${(r.config as FlowkiteConfig).database}`
          : `${c.host}${c.port ? `:${c.port}` : ""} / ${c.database}`,
    tables: r.tables as DataSourceTable[],
    error: r.error,
    refreshedAt: r.refreshedAt.toISOString(),
    createdBy: r.createdBy,
    projects,
  };
}

export async function listDataSources(): Promise<DataSource[]> {
  const [rows, uses] = await Promise.all([
    db.select().from(schema.dataSource).orderBy(schema.dataSource.name),
    db.select({ id: schema.projectDataSource.sourceId, n: count() }).from(schema.projectDataSource).groupBy(schema.projectDataSource.sourceId),
  ]);
  const used = new Map(uses.map((u) => [u.id, Number(u.n)]));
  return rows.map((r) => toApi(r, used.get(r.id) ?? 0));
}

export async function createDataSource(input: CreateDataSourceInput, by: string): Promise<DataSource> {
  const [taken] = await db.select({ id: schema.dataSource.id }).from(schema.dataSource).where(eq(schema.dataSource.name, input.name));
  if (taken) throw new DataSourceError(`A data source called "${input.name}" already exists.`);
  const id = newId();
  let row: Row;
  if (input.kind === "flowkite") {
    row = {
      id,
      name: input.name,
      title: input.title,
      kind: "flowkite",
      config: { gatewayUrl: input.gatewayUrl.replace(/\/+$/, ""), database: input.database } satisfies FlowkiteConfig,
      secret: encrypt(JSON.stringify({ apiKey: input.apiKey }), AAD(id)),
      tables: [],
      error: null,
      refreshedAt: new Date(),
      createdBy: by,
      createdAt: new Date(),
    };
  } else if (input.kind === "sheet") {
    const data = Buffer.from(input.dataBase64, "base64");
    if (data.length > 20 * 1024 * 1024) throw new DataSourceError("Spreadsheets can be up to 20 MB.");
    await buildSheetDatabase(id, input.fileName, data);
    row = { id, name: input.name, title: input.title, kind: "sheet", config: { fileName: input.fileName }, secret: null, tables: [], error: null, refreshedAt: new Date(), createdBy: by, createdAt: new Date() };
  } else {
    const { password, ...config } = input.connection;
    row = {
      id,
      name: input.name,
      title: input.title,
      kind: input.kind,
      config,
      secret: encrypt(JSON.stringify({ password }), AAD(id)),
      tables: [],
      error: null,
      refreshedAt: new Date(),
      createdBy: by,
      createdAt: new Date(),
    };
  }
  // Connect and read the structure before saving, so a wrong password is caught now.
  try {
    row.tables = await introspect(row);
  } catch (err) {
    await closeClient(id);
    if (input.kind === "sheet") rmSync(join(DATASETS_DIR, `${id}.sqlite`), { force: true });
    throw new DataSourceError(`Couldn't connect: ${err instanceof Error ? err.message : String(err)}`);
  }
  await db.insert(schema.dataSource).values(row);
  return toApi(row, 0);
}

export async function getDataSource(id: string): Promise<DataSourceDetails> {
  const [row] = await db.select().from(schema.dataSource).where(eq(schema.dataSource.id, id));
  if (!row) throw new DataSourceError("That data source no longer exists.");
  const usedBy = await db
    .select({ id: schema.project.id, name: schema.project.name })
    .from(schema.projectDataSource)
    .innerJoin(schema.project, eq(schema.project.id, schema.projectDataSource.projectId))
    .where(eq(schema.projectDataSource.sourceId, id))
    .orderBy(schema.project.name);
  return { ...toApi(row, usedBy.length), usedBy };
}

/** Change the title, rotate the password / API key, or replace a spreadsheet; the structure is read again. */
export async function updateDataSource(id: string, input: UpdateDataSourceInput): Promise<DataSourceDetails> {
  const [row] = await db.select().from(schema.dataSource).where(eq(schema.dataSource.id, id));
  if (!row) throw new DataSourceError("That data source no longer exists.");
  const next: Row = { ...row };
  if (input.title) next.title = input.title;
  if (input.password !== undefined && ["postgres", "mssql", "mysql"].includes(row.kind)) next.secret = encrypt(JSON.stringify({ password: input.password }), AAD(id));
  if (input.apiKey && row.kind === "flowkite") next.secret = encrypt(JSON.stringify({ apiKey: input.apiKey }), AAD(id));
  const reconnect = next.secret !== row.secret || Boolean(input.dataBase64);
  if (input.dataBase64 && row.kind === "sheet") {
    const data = Buffer.from(input.dataBase64, "base64");
    if (data.length > 20 * 1024 * 1024) throw new DataSourceError("Spreadsheets can be up to 20 MB.");
    await closeClient(id);
    await buildSheetDatabase(id, input.fileName ?? (row.config as SheetConfig).fileName, data);
    next.config = { fileName: input.fileName ?? (row.config as SheetConfig).fileName };
  }
  if (reconnect) {
    await closeClient(id);
    try {
      next.tables = await introspect(next);
      next.error = null;
      next.refreshedAt = new Date();
    } catch (err) {
      await closeClient(id);
      throw new DataSourceError(`Couldn't connect with the new details: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await db
    .update(schema.dataSource)
    .set({ title: next.title, secret: next.secret, config: next.config, tables: next.tables, error: next.error, refreshedAt: next.refreshedAt })
    .where(eq(schema.dataSource.id, id));
  return getDataSource(id);
}

export async function refreshDataSource(id: string): Promise<DataSource> {
  const [row] = await db.select().from(schema.dataSource).where(eq(schema.dataSource.id, id));
  if (!row) throw new DataSourceError("That data source no longer exists.");
  await closeClient(id);
  let tables = row.tables as DataSourceTable[];
  let error: string | null = null;
  try {
    tables = await introspect(row);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await db.update(schema.dataSource).set({ tables, error, refreshedAt: new Date() }).where(eq(schema.dataSource.id, id));
  const [n] = await db.select({ n: count() }).from(schema.projectDataSource).where(eq(schema.projectDataSource.sourceId, id));
  return toApi({ ...row, tables, error, refreshedAt: new Date() }, Number(n?.n ?? 0));
}

export async function deleteDataSource(id: string) {
  await closeClient(id);
  await db.delete(schema.dataSource).where(eq(schema.dataSource.id, id));
  rmSync(join(DATASETS_DIR, `${id}.sqlite`), { force: true });
}

/* ------------------------------- projects -------------------------------- */

export async function projectDataSourceIds(projectId: string): Promise<string[]> {
  const rows = await db.select({ id: schema.projectDataSource.sourceId }).from(schema.projectDataSource).where(eq(schema.projectDataSource.projectId, projectId));
  return rows.map((r) => r.id);
}

async function projectSources(projectId: string): Promise<Row[]> {
  const rows = await db
    .select({ s: schema.dataSource })
    .from(schema.projectDataSource)
    .innerJoin(schema.dataSource, eq(schema.dataSource.id, schema.projectDataSource.sourceId))
    .where(eq(schema.projectDataSource.projectId, projectId))
    .orderBy(schema.dataSource.name);
  return rows.map((r) => r.s);
}

/** The helper the app uses (src/lib/forge-data.ts), typed with the project's source names. */
function helperFile(names: string[]): string {
  return `// Generated by Forge: read-only access to the company data sources this project uses.
// Server code only (server components, route handlers, server actions). Never import it in a client
// component: the token is for the server. Pass values as params; never paste them into the SQL.
// Only SELECT queries run; at most 2000 rows come back (check \`truncated\`), so filter and
// aggregate in SQL.

export type DataSourceName = ${names.length ? names.map((n) => JSON.stringify(n)).join(" | ") : "never"};
export type QueryResult<T = Record<string, unknown>> = { columns: string[]; rows: T[]; truncated: boolean };

export async function query<T = Record<string, unknown>>(source: DataSourceName, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  const url = process.env.FORGE_DATA_URL;
  const token = process.env.FORGE_DATA_TOKEN;
  if (!url || !token) throw new Error("Company data isn't available here (FORGE_DATA_URL / FORGE_DATA_TOKEN are missing).");
  const res = await fetch(\`\${url}/query\`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: \`Bearer \${token}\` },
    body: JSON.stringify({ source, sql, params }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as QueryResult<T> & { error?: string };
  if (!res.ok) throw new Error(\`Query on "\${source}" failed: \${body.error ?? res.status}\`);
  return body;
}

export type OperationResult<T = Record<string, unknown>> = { rows: T[]; nextPage?: string | null; truncated?: boolean };

/**
 * Flowkite sources run named read operations instead of SQL. The body is what the operation takes:
 * { filters, search, sort, page: { size, after }, key, inputs } (see the operation's inputs).
 */
export async function callOperation<T = Record<string, unknown>>(source: DataSourceName, operation: string, body: Record<string, unknown> = {}): Promise<OperationResult<T>> {
  const url = process.env.FORGE_DATA_URL;
  const token = process.env.FORGE_DATA_TOKEN;
  if (!url || !token) throw new Error("Company data isn't available here (FORGE_DATA_URL / FORGE_DATA_TOKEN are missing).");
  const res = await fetch(\`\${url}/operation\`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: \`Bearer \${token}\` },
    body: JSON.stringify({ source, operation, body }),
    cache: "no-store",
  });
  const out = (await res.json().catch(() => ({}))) as OperationResult<T> & { error?: string };
  if (!res.ok) throw new Error(\`"\${operation}" on "\${source}" failed: \${out.error ?? res.status}\`);
  return out;
}
`;
}

/** Choose the project's sources; writes and commits the helper (when no run is active). */
export async function setProjectDataSources(projectId: string, ids: string[]) {
  if (activeRunId(projectId)) throw new RunConflictError("Wait for the agent to finish before changing data sources.");
  const valid = ids.length ? await db.select({ id: schema.dataSource.id }).from(schema.dataSource).where(inArray(schema.dataSource.id, ids)) : [];
  await db.delete(schema.projectDataSource).where(eq(schema.projectDataSource.projectId, projectId));
  if (valid.length) await db.insert(schema.projectDataSource).values(valid.map((v) => ({ projectId, sourceId: v.id })));

  await ensureSandbox(projectId);
  const sources = await projectSources(projectId);
  const path = "src/lib/forge-data.ts";
  if (sources.length) await putFiles(projectId, [{ path, content: helperFile(sources.map((s) => s.name)) }]);
  else await exec(projectId, ["rm", "-f", path]);
  await exec(projectId, [
    "sh",
    "-c",
    `git add -A -- ${path} && if git diff --cached --quiet -- ${path}; then true; else git commit -q -m "Update company data sources" -- ${path}; fi`,
  ]);
}

/** What the build agent is told about the project's data sources. */
export async function dataSourcesPrompt(projectId: string): Promise<string> {
  const sources = await projectSources(projectId);
  if (!sources.length) return "";
  const parts = sources.map((s) => {
    const kind = s.kind as DataSourceKind;
    if (kind === "flowkite") {
      const ops = (s.tables as DataSourceTable[]).slice(0, 60).map(
        (t) =>
          `- ${t.name}${t.summary ? ` (${t.summary})` : ""}: returns ${t.columns.map((c) => `${c.name} ${c.type}`).join(", ") || "rows"}${t.inputs?.length ? `; body fields: ${t.inputs.join(", ")}` : ""}`,
      );
      return [`### ${s.name}: ${s.title} (Flowkite; call its operations with callOperation("${s.name}", "<operation>", body))`, ...ops].join("\n");
    }
    const tables = (s.tables as DataSourceTable[]).slice(0, 60).map((t) => {
      const cols = t.columns.slice(0, 40).map((c) => `${c.name} ${c.type}`).join(", ");
      return `- ${t.schema ? `${t.schema}.` : ""}${t.name}${t.rows !== undefined ? ` (${t.rows} rows)` : ""}: ${cols}${t.columns.length > 40 ? ", …" : ""}`;
    });
    return [`### ${s.name}: ${s.title} (${KIND_LABEL[kind]}; parameters ${PLACEHOLDERS[kind]})`, ...tables, (s.tables as DataSourceTable[]).length > 60 ? "- …" : ""]
      .filter(Boolean)
      .join("\n");
  });
  return [
    "## Company data (read-only)",
    "This project may read these data sources. Use the helpers in `src/lib/forge-data.ts` (already in the project) in server code only: server components, route handlers or server actions, never client components. Databases and spreadsheets: `query(source, sql, params)`; only SELECT works; always pass values as params with the placeholders shown; results stop at 2000 rows, so filter, sort and aggregate in SQL and paginate long lists. Flowkite sources: `callOperation(source, operation, body)` with the operations listed (read-only; page with `page: { size, after: nextPage }`). Show friendly loading and empty states, and handle errors.",
    ...parts,
  ].join("\n\n");
}

/* ------------------------------- data proxy ------------------------------ */

const sign = (projectId: string) => createHmac("sha256", env.BETTER_AUTH_SECRET).update(`forge-data:${projectId}`).digest("base64url");
/** The token a project's dev server uses (env FORGE_DATA_TOKEN). */
export const dataToken = (projectId: string) => `forge-data.${projectId}.${sign(projectId)}`;

function projectFromToken(header: string | undefined): string | null {
  const m = /^Bearer forge-data\.([a-z0-9]{6,32})\.([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!m) return null;
  const want = Buffer.from(sign(m[1]!));
  const got = Buffer.from(m[2]!);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1]! : null;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new DataSourceError("The request is too large.");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const reply = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export function startDataProxy() {
  const server = createServer(async (req, res) => {
    const projectId = projectFromToken(req.headers.authorization);
    // The API gateway shares this server (and the project token): /api/<connection>/<path>.
    if (req.url?.startsWith("/api/")) {
      if (!projectId) return reply(res, 401, { error: "Invalid project token." });
      return handleGateway(req, res, projectId).catch((err) => {
        if (!res.headersSent) reply(res, 502, { error: (err as Error).message });
      });
    }
    if (req.method !== "POST" || (req.url !== "/query" && req.url !== "/operation")) return reply(res, 404, { error: "Not found" });
    if (!projectId) return reply(res, 401, { error: "Invalid data token." });
    if (req.url === "/operation") {
      try {
        const body = (await readBody(req)) as { source?: unknown; operation?: unknown; body?: unknown };
        if (typeof body.source !== "string" || typeof body.operation !== "string") return reply(res, 400, { error: "Send { source, operation, body }." });
        const [row] = await db
          .select({ s: schema.dataSource })
          .from(schema.projectDataSource)
          .innerJoin(schema.dataSource, eq(schema.dataSource.id, schema.projectDataSource.sourceId))
          .where(and(eq(schema.projectDataSource.projectId, projectId), eq(schema.dataSource.name, body.source)));
        if (!row) return reply(res, 403, { error: `This project can't use the data source "${body.source}". Add it in the project's APIs & data.` });
        return reply(res, 200, await runOperation(row.s, body.operation, body.body));
      } catch (err) {
        return reply(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    try {
      const body = (await readBody(req)) as { source?: unknown; sql?: unknown; params?: unknown };
      if (typeof body.source !== "string" || typeof body.sql !== "string" || body.sql.length > 20_000) return reply(res, 400, { error: "Send { source, sql, params }." });
      const params = Array.isArray(body.params) ? body.params.slice(0, 100) : [];
      const [row] = await db
        .select({ s: schema.dataSource })
        .from(schema.projectDataSource)
        .innerJoin(schema.dataSource, eq(schema.dataSource.id, schema.projectDataSource.sourceId))
        .where(and(eq(schema.projectDataSource.projectId, projectId), eq(schema.dataSource.name, body.source)));
      if (!row) return reply(res, 403, { error: `This project can't use the data source "${body.source}". Add it in the project's APIs & data.` });
      return reply(res, 200, await run(row.s, body.sql, params));
    } catch (err) {
      return reply(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(env.DATA_PROXY_PORT, env.MODEL_PROXY_HOST, () => console.log(`data proxy and API gateway on ${env.MODEL_PROXY_HOST}:${env.DATA_PROXY_PORT}`));
}

/** For admins: run a Flowkite operation from Settings › Data sources (preview). */
export async function previewOperation(id: string, operation: string, body: unknown) {
  const [row] = await db.select().from(schema.dataSource).where(eq(schema.dataSource.id, id));
  if (!row) throw new DataSourceError("That data source no longer exists.");
  const r = await runOperation(row, operation, body);
  return { ...r, rows: r.rows.slice(0, 50), truncated: r.truncated || r.rows.length > 50 };
}

/** For admins: run a query from Settings › Data sources (preview). */
export async function previewQuery(id: string, sqlText: string): Promise<QueryResult> {
  const [row] = await db.select().from(schema.dataSource).where(eq(schema.dataSource.id, id));
  if (!row) throw new DataSourceError("That data source no longer exists.");
  const r = await run(row, sqlText, []);
  return { ...r, rows: r.rows.slice(0, 50), truncated: r.truncated || r.rows.length > 50 };
}
