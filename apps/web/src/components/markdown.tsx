"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Agent-written Markdown (plans, messages). Raw HTML is not rendered. */
export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div
      className={`space-y-2 break-words [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-surface [&_pre]:p-2 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 ${className}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
