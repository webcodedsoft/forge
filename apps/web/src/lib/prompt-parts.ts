/* The parts of a request that send() adds after the person's words (builder project-view.tsx). */

/** Splits off the "(Attached files…)" line that send() adds; returns the rest and the file paths. */
export function splitAttachments(prompt: string): [string, string[]] {
  const m = /\n\n\(Attached files, open them with the Read tool: ([^)]*)\)$/.exec(prompt);
  if (!m) return [prompt, []];
  return [prompt.slice(0, m.index), m[1]!.split(", ").filter(Boolean)];
}

/** Splits a prompt into the user's words and a short label for the element picked in the preview. */
export function splitElementContext(prompt: string): [string, string | null] {
  const i = prompt.indexOf("\n\n(Selected in the preview on ");
  if (i < 0) return [prompt, null];
  const head = prompt.slice(i + 2).split("\n")[0] ?? "";
  const m = /a <(\w+)>(?: showing "([^"]*)")?(?:, in the "([^"]*)" section)?/.exec(head);
  const label = m ? `<${m[1]}>${m[2] ? ` "${m[2].slice(0, 40)}"` : ""}${m[3] ? ` in ${m[3]}` : ""}` : "an element";
  return [prompt.slice(0, i), `Selected: ${label}`];
}
