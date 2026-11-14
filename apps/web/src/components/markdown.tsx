"use client";

import { isValidElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";

/**
 * Agent-written Markdown (plans, messages, text still streaming in). Raw HTML is not rendered.
 * A single line break is kept as a break, as in chat (models often write "**Problem:**" and the
 * next line with one newline between them).
 */
/** Fenced code (```lang) becomes a highlighted, copyable block; inline `code` stays inline. */
const COMPONENTS: Components = {
  pre({ children }) {
    const child = (Array.isArray(children) ? children[0] : children) as ReactNode;
    if (!isValidElement(child)) return <pre>{children}</pre>;
    const props = (child as ReactElement<{ className?: string; children?: ReactNode }>).props;
    const lang = /language-([\w+#.-]+)/.exec(props.className ?? "")?.[1];
    const code = Array.isArray(props.children) ? props.children.join("") : String(props.children ?? "");
    return <CodeBlock code={code} lang={lang} />;
  },
};

export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div
      className={`min-w-0 max-w-full space-y-2 break-words [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-surface [&_pre]:p-2 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 ${className}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={COMPONENTS}>{children}</ReactMarkdown>
    </div>
  );
}
