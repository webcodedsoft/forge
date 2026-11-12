"use client";

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

/*
 * Code editor (CodeMirror 6) for everything code-like in Forge: SQL consoles, JSON bodies, OpenAPI
 * specs, Markdown docs, and read-only file views. Colours come from CSS variables (globals.css,
 * "Code editor"), so it follows Forge's light/dark theme. ⌘↵ / Ctrl↵ calls onRun when given.
 */

export type CodeLanguage = "sql" | "json" | "yaml" | "markdown" | "javascript" | "typescript" | "jsx" | "tsx" | "css" | "html" | "text";

/** The language for a file name (for read-only file views). */
export function languageForFile(path: string): CodeLanguage {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, CodeLanguage> = {
    sql: "sql",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    mdx: "markdown",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "jsx",
    ts: "typescript",
    mts: "typescript",
    tsx: "tsx",
    css: "css",
    html: "html",
    htm: "html",
    svg: "html",
  };
  return map[ext] ?? "text";
}

function languageExtension(lang: CodeLanguage): Extension {
  switch (lang) {
    case "sql":
      return sql();
    case "json":
      return json();
    case "yaml":
      return yaml();
    case "markdown":
      return markdown();
    case "javascript":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "css":
      return css();
    case "html":
      return html();
    default:
      return [];
  }
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword], color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--code-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--code-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--code-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--code-property)" },
  { tag: [t.tagName], color: "var(--code-keyword)" },
  { tag: [t.heading], color: "var(--code-keyword)", fontWeight: "700" },
  { tag: [t.link, t.url], color: "var(--code-string)", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.punctuation, t.bracket, t.separator], color: "var(--code-punct)" },
  { tag: [t.invalid], color: "var(--danger)" },
]);

const baseTheme = EditorView.theme({
  "&": { backgroundColor: "var(--code-bg)", color: "var(--ink)", fontSize: "12.5px", borderRadius: "8px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-jetbrains), ui-monospace, monospace", lineHeight: "1.6" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--primary)" },
  ".cm-gutters": { backgroundColor: "var(--code-bg)", color: "var(--ink-3)", border: "none", borderRight: "1px solid var(--line)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink)" },
  ".cm-activeLine": { backgroundColor: "var(--code-active)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--primary)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--code-selection) !important" },
  ".cm-selectionMatch": { backgroundColor: "var(--code-active)" },
  ".cm-matchingBracket": { backgroundColor: "var(--primary-weak)", outline: "1px solid var(--primary-ring)" },
  ".cm-placeholder": { color: "var(--ink-3)", fontStyle: "italic" },
  ".cm-foldGutter span": { color: "var(--ink-3)" },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--ink)", borderColor: "var(--line)" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "12px" },
  ".cm-textfield": { backgroundColor: "var(--surface)", border: "1px solid var(--line-2)", borderRadius: "4px", color: "var(--ink)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--surface-2)", border: "1px solid var(--line-2)", borderRadius: "4px", color: "var(--ink)" },
});

export function CodeEditor({
  value,
  onChange,
  language = "text",
  readOnly = false,
  onRun,
  placeholder,
  minHeight = 96,
  maxHeight = 420,
  lineNumbers: showLines = true,
  wrap = false,
  ariaLabel,
  className = "",
  id,
}: {
  value: string;
  onChange?: (value: string) => void;
  language?: CodeLanguage;
  readOnly?: boolean;
  /** ⌘↵ / Ctrl↵ */
  onRun?: () => void;
  placeholder?: string;
  minHeight?: number;
  /** null = grow with the content (the page scrolls). */
  maxHeight?: number | null;
  lineNumbers?: boolean;
  wrap?: boolean;
  ariaLabel?: string;
  className?: string;
  id?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langC = useRef(new Compartment());
  const roC = useRef(new Compartment());
  // Latest callbacks without re-creating the editor.
  const cb = useRef({ onChange, onRun });
  useEffect(() => {
    cb.current = { onChange, onRun };
  }, [onChange, onRun]);

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...(showLines ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(highlight),
          baseTheme,
          wrap ? EditorView.lineWrapping : [],
          placeholder ? placeholderExt(placeholder) : [],
          EditorView.theme({
            ".cm-scroller": { minHeight: `${minHeight}px`, ...(maxHeight ? { maxHeight: `${maxHeight}px` } : {}), overflow: "auto" },
          }),
          keymap.of([
            { key: "Mod-Enter", run: () => (cb.current.onRun ? (cb.current.onRun(), true) : false) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          langC.current.of(languageExtension(language)),
          roC.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel ?? `${readOnly ? "Code" : "Code editor"} (${language})`,
            ...(id ? { id } : {}),
            spellcheck: "false",
            autocorrect: "off",
            autocapitalize: "off",
            "data-gramm": "false",
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once; props below are synced through compartments and transactions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: langC.current.reconfigure(languageExtension(language)) });
  }, [language]);
  useEffect(() => {
    view.current?.dispatch({ effects: roC.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);
  // A value changed from outside (a new file, a reset) replaces the document.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={host}
      className={`overflow-hidden rounded-lg border border-line-2 transition-shadow focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--primary-ring)] ${className}`}
    />
  );
}
