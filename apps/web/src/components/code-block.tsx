"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { type CodeLanguage, CodeEditor } from "./code-editor";

/*
 * A code block inside agent messages (Markdown ``` fences): Forge's code editor, read-only, with
 * the language and a Copy button. Fences without a language get a best guess.
 */

const ALIASES: Record<string, CodeLanguage> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  html: "html",
  xml: "html",
  svg: "html",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
};

const LABELS: Partial<Record<CodeLanguage, string>> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  sql: "SQL",
  yaml: "YAML",
  markdown: "Markdown",
};

function guess(code: string): CodeLanguage {
  const s = code.trimStart();
  if (/^[[{]/.test(s) && /^[\s\S]*[\]}]\s*$/.test(s.trimEnd())) {
    try {
      JSON.parse(s);
      return "json";
    } catch {
      /* not JSON */
    }
  }
  if (/^\s*(select|insert|update|delete|with|create)\s/i.test(s)) return "sql";
  if (/<[A-Za-z][\w.]*[\s/>]/.test(s) && /(import |export |return|=>|function )/.test(s)) return "tsx";
  if (/(^|\n)\s*(import |export |const |let |function |interface |type )/.test(s)) return "typescript";
  if (/^[.#@a-z][^{]*\{[^}]*:[^}]*\}/i.test(s)) return "css";
  return "text";
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const given = lang?.toLowerCase();
  const language: CodeLanguage = (given && ALIASES[given]) || guess(code);
  // Shell and other languages without highlighting keep their own name.
  const label = LABELS[language] ?? (given ? given : "Code");
  const [copied, setCopied] = useState(false);
  const text = code.replace(/\n$/, "");
  return (
    // Fixed to the column's width (grid + minmax(0,1fr)): long lines scroll inside the block
    // instead of widening the chat.
    <div className="not-prose my-1 grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)] overflow-hidden rounded-lg border border-line bg-[var(--code-bg)]">
      <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-2.5 py-1">
        <span className="font-mono text-[11px] text-ink-3">{label}</span>
        <button
          type="button"
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-ink-2 hover:bg-surface hover:text-ink"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          aria-label="Copy code"
        >
          {copied ? <Check size={12} className="text-ok" aria-hidden /> : <Copy size={12} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <CodeEditor value={text} language={language} readOnly lineNumbers={false} minHeight={0} maxHeight={360} ariaLabel={`${label} code`} className="text-[12px]" />
    </div>
  );
}
