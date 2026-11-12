import type { DataSourceKind } from "@forge/protocol";
import { Database, FileSpreadsheet, Share2, Workflow } from "lucide-react";
import type { ReactNode } from "react";

/** The kinds of data source, as the Add modal and the pages show them. */
export const KINDS: { id: DataSourceKind | "sharepoint"; label: string; text: string; icon: (size: number) => ReactNode; port?: number; soon?: string }[] = [
  { id: "postgres", label: "PostgreSQL", text: "A database, with a read-only login", icon: (s) => <Database size={s} aria-hidden />, port: 5432 },
  { id: "mssql", label: "SQL Server", text: "A database, with a read-only login", icon: (s) => <Database size={s} aria-hidden />, port: 1433 },
  { id: "mysql", label: "MySQL", text: "A database, with a read-only login", icon: (s) => <Database size={s} aria-hidden />, port: 3306 },
  { id: "sheet", label: "Excel or CSV", text: "Upload a file; each sheet is a table", icon: (s) => <FileSpreadsheet size={s} aria-hidden /> },
  { id: "flowkite", label: "Flowkite", text: "A Flowkite Database API key; its read operations", icon: (s) => <Workflow size={s} aria-hidden /> },
  { id: "sharepoint", label: "SharePoint list", text: "Comes with company (Entra) sign-in", icon: (s) => <Share2 size={s} aria-hidden />, soon: "soon" },
];

export const KIND_LABEL: Record<DataSourceKind, string> = { postgres: "PostgreSQL", mssql: "SQL Server", mysql: "MySQL", sheet: "Spreadsheet", flowkite: "Flowkite" };

export const kindIcon = (k: DataSourceKind, size = 19) => KINDS.find((x) => x.id === k)!.icon(size);

/** A file as base64 (for uploads). */
export function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read the file."));
    r.readAsDataURL(file);
  });
}
