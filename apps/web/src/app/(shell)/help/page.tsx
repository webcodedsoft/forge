import { AtSign, Bot, Code2, Eye, FlaskConical, GitBranch, History, KeyRound, Library, MessageSquarePlus, MousePointerClick, Users } from "lucide-react";

const SECTIONS = [
  {
    icon: Bot,
    title: "Building with the agent",
    body: [
      "Describe what you want in the prompt box and press Enter. The agent edits the app and the preview updates as it works.",
      "Pick a mode next to Send (⌥P switches): Build makes changes directly, Chat answers questions without changing anything, and Plan writes a spec you approve before anything is built.",
      "Forge saves a version only when its checks pass: dependencies install, type check, lint and a browser test that every page loads without errors.",
    ],
  },
  {
    icon: AtSign,
    title: "Adding context and files",
    body: [
      "Type @ or use + → Add context to point the agent at a page (like @/about) or a file (like @src/app/page.tsx).",
      "Attach screenshots, PDFs or text files with + → Attach files, or paste a screenshot into the prompt box. The agent opens them before it starts.",
    ],
  },
  {
    icon: MousePointerClick,
    title: "Changing a specific part",
    body: [
      "Click Select element above the preview, then click any part of the app. Your next request applies to that element.",
      "With an element selected, Save to library turns it into a reusable component for the whole team.",
    ],
  },
  {
    icon: Eye,
    title: "The preview browser",
    body: [
      "Use back, forward and reload like a normal browser. Type a path in the address bar, or pick a page from the pages list.",
      "Desktop and phone sizes show how the app looks on each. More (the stacked icon) opens the app in a new tab, copies the link, downloads the code or restarts the app server.",
    ],
  },
  {
    icon: Code2,
    title: "Code",
    body: ["Switch to Code to browse the app's files (read only). Ask the agent for changes rather than editing files by hand."],
  },
  {
    icon: MessageSquarePlus,
    title: "Comments",
    body: [
      "Click Comment, then any part of the app, to leave a note pinned to it. Teammates see the pin, reply and resolve.",
      "Builders can hand a comment to the agent with Ask the agent to fix this.",
    ],
  },
  { icon: History, title: "Versions", body: ["Every saved version is listed under Versions. Restore one to make the app match it again; nothing is lost, the restore is a new version."] },
  { icon: FlaskConical, title: "Testing", body: ["Test the app sends a QA agent through the app in a real browser; you can watch it live. Turn on Auto-test to test after every saved version, within a daily budget."] },
  { icon: KeyRound, title: "Secrets", body: ["Store API keys and settings under Secrets. They're encrypted, given only to the running app, and never shown again. Use test or development keys, not production ones."] },
  { icon: Library, title: "Templates and library", body: ["Save a project as a team template from Versions, and start new projects from it. Saved components are reused by the agent in every project."] },
  { icon: GitBranch, title: "GitHub repos", body: ["Import a repository from the home page. Changes are saved on a forge/… branch; Open pull request sends them back for review."] },
  {
    icon: Users,
    title: "People and roles",
    body: [
      "Team roles: admins manage everything, builders create projects, members only see projects shared with them.",
      "Project roles: admins manage access (Share), builders make changes, viewers look around and comment.",
    ],
  },
];

/** Built-in help center. */
export default function HelpPage() {
  return (
    <main className="flex max-w-4xl flex-col gap-5 px-5 py-6 sm:px-7">
      <div>
        <h1 className="h1">Help center</h1>
        <p className="mt-1 text-ink-2">How to build, review and share apps in Forge.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {SECTIONS.map(({ icon: Icon, title, body }) => (
          <section key={title} className="card flex flex-col gap-2 p-4">
            <h2 className="h2 flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-md bg-primary-weak text-primary">
                <Icon size={15} aria-hidden />
              </span>
              {title}
            </h2>
            {body.map((b) => (
              <p key={b} className="text-[13px] leading-relaxed text-ink-2">
                {b}
              </p>
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}
