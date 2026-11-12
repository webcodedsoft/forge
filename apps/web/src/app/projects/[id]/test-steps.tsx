import type { TestStep, TestTarget } from "@forge/protocol";

/** "the button “Vote”", "the field “Name”", "“Leading”". */
export function targetText(t: TestTarget): string {
  if (t.role) return `the ${t.role}${t.name ? ` “${t.name}”` : ""}`;
  if (t.label) return `the field “${t.label}”`;
  if (t.text) return `“${t.text}”`;
  return `the element ${t.selector}`;
}

/** One step in plain words, for people reading a test. */
export function stepText(s: TestStep): string {
  switch (s.action) {
    case "open":
      return `Open ${s.path}`;
    case "click":
      return `Click ${targetText(s.target)}`;
    case "fill":
      return `Type “${s.value}” into ${targetText(s.target)}`;
    case "press":
      return `Press ${s.key}`;
    case "expect":
      return s.state === "visible"
        ? `Check ${targetText(s.target)} is shown`
        : s.state === "hidden"
          ? `Check ${targetText(s.target)} is gone`
          : `Check ${targetText(s.target)} says “${s.value ?? ""}”`;
  }
}

/** The steps as a numbered list; the failed one (if any) is marked. */
export function StepList({ steps, failedStep }: { steps: TestStep[]; failedStep?: number }) {
  return (
    <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-[12.5px] text-ink-2">
      {steps.map((s, i) => (
        <li key={i} className={i === failedStep ? "font-semibold text-danger" : s.action === "expect" ? "text-ink" : ""}>
          {stepText(s)}
          {i === failedStep && " ← failed here"}
        </li>
      ))}
    </ol>
  );
}

/** A request for the agent when a saved test fails. */
export function failedTestPrompt(title: string, steps: TestStep[], failedStep: number | undefined, error: string | undefined): string {
  return [
    `The saved test "${title}" fails on the current version. Find out why and fix the app (not the test), then summarize what you changed.`,
    "",
    "Steps:",
    ...steps.map((s, i) => `${i + 1}. ${stepText(s)}${i === failedStep ? "   ← fails here" : ""}`),
    "",
    `What happened: ${error ?? "unknown"}`,
    "If the app changed on purpose and the test is out of date, say so instead of changing the app.",
  ].join("\n");
}
