/*
 * The help center's articles. Each has a short summary (shown collapsed and searched) and steps or
 * paragraphs (shown when opened). Keep wording plain; name buttons exactly as they appear.
 */

export type Article = {
  id: string;
  title: string;
  icon: string;
  summary: string;
  steps?: string[];
  body?: string[];
  tip?: string;
};

export type Category = { id: string; title: string; blurb: string; icon: string; articles: Article[] };

export const CATEGORIES: Category[] = [
  {
    id: "start",
    title: "Getting started",
    blurb: "Create your first app and learn the builder.",
    icon: "Rocket",
    articles: [
      {
        id: "first-app",
        title: "Create your first app",
        icon: "Sparkles",
        summary: "Describe the app on the home page and the agent builds it.",
        steps: [
          "On Projects, describe the app in “What do you want to build?”: who uses it and what they need to do.",
          "Optionally pick a template under Start from, attach files (a sketch, a spreadsheet, a brief), and give the project a name.",
          "Press Build. The builder opens and the agent starts working; the preview updates as it goes.",
          "When Forge's checks pass, the first version is saved automatically.",
        ],
        tip: "Be specific about pages, fields and who can do what. A screenshot of something you like helps a lot.",
      },
      {
        id: "builder-tour",
        title: "A tour of the builder",
        icon: "LayoutDashboard",
        summary: "Chat on the left, the live app on the right, and tabs for everything else.",
        body: [
          "Build is where you talk to the agent. Comments, Versions, Spec, Brain and Health are tabs next to it.",
          "The right side shows the running app (Preview), its files (Code) and what changed (Changes).",
          "The bar at the bottom of the chat shows what the agent is doing right now and how long it has been working.",
        ],
      },
      {
        id: "modes",
        title: "Build, Chat, Plan and Design modes",
        icon: "Hammer",
        summary: "Choose how the agent handles your next message.",
        body: [
          "Build makes changes directly. Chat answers questions and changes nothing. Plan writes a spec you approve before anything is built. Design turns a screenshot or Figma frame into working screens.",
          "Pick a mode next to Send; ⌥P (Alt+P) switches between them.",
        ],
      },
    ],
  },
  {
    id: "build",
    title: "Building and changing apps",
    blurb: "Ask for changes, point at parts of the app, add context.",
    icon: "Hammer",
    articles: [
      {
        id: "ask",
        title: "Ask for a change",
        icon: "MessageSquare",
        summary: "Type what you want and press Enter; keep sending while the agent works.",
        steps: [
          "Describe the change in the prompt box and press Enter (Shift+Enter adds a new line).",
          "While the agent works you can keep typing: messages wait under Queued and run in order when it's done.",
          "Remove a queued message with ✕. After Stop, the queue waits until you press Run next.",
        ],
      },
      {
        id: "models",
        title: "Choose the AI model",
        icon: "Sparkles",
        summary: "Pick a model per message: cheaper ones for small edits, stronger ones for big changes.",
        body: [
          "The model picker sits next to the mode in the prompt box. It lists the models your admin allows, with a hint and a cost level (Low, Medium or High cost).",
          "The project remembers your choice. Each answer's cost line shows which model answered.",
          "If one model keeps getting stuck on a problem, trying another often helps.",
        ],
      },
      {
        id: "select",
        title: "Change a specific part",
        icon: "MousePointerClick",
        summary: "Select an element in the preview so your request applies to it.",
        steps: [
          "Click Select element above the preview.",
          "Click the part of the app you mean. It shows as Editing above the prompt box.",
          "Describe the change and send it. Save to library turns the selected part into a reusable component.",
        ],
      },
      {
        id: "context",
        title: "Add context and files",
        icon: "Paperclip",
        summary: "Point the agent at pages and files, or attach your own material.",
        body: [
          "Type @ in the prompt box (or use + › Add context) to mention a page like @/about or a file like @src/app/page.tsx.",
          "Attach images, PDFs, Word, Excel, PowerPoint or text files with + › Attach files, by dragging them onto the prompt box, or by pasting a screenshot. Up to 8 files of 20 MB each.",
          "The agent reads every attachment before it starts, and copies images into the app when they should appear in it.",
        ],
      },
      {
        id: "design",
        title: "Build from a design",
        icon: "Palette",
        summary: "Turn a screenshot or a Figma frame into working UI.",
        body: [
          "Switch to Design mode, attach a screenshot or paste a Figma frame link, and say where it goes.",
          "Forge imports the frame's sizes, colours, fonts and texts; the agent builds it and compares the result with the design on desktop and phone.",
        ],
        tip: "Figma links need a Figma token in Settings › Integrations.",
      },
    ],
  },
  {
    id: "review",
    title: "Reviewing and quality",
    blurb: "Preview, versions, tests, problems and security.",
    icon: "ShieldCheck",
    articles: [
      {
        id: "preview",
        title: "Use the preview",
        icon: "Globe",
        summary: "Browse the app like a normal browser, on desktop or phone sizes.",
        body: [
          "Use back, forward and reload, type a path in the address bar, or pick a page from the pages list.",
          "The size menu switches between desktop, tablet and phone. Drag the frame's edges to try any width.",
          "More copies the preview link, downloads the code (.zip) or restarts the app server.",
        ],
      },
      {
        id: "versions",
        title: "Versions, comparing and restoring",
        icon: "History",
        summary: "Every saved version is kept; compare any two or restore one.",
        body: [
          "Forge saves a version only when its checks pass: install, type check, lint, tests, and every page loading without errors.",
          "Under Versions, Changes shows what a version changed and Compare with current shows the difference with now.",
          "Restore makes the app match a version again. Nothing is lost: the restore is saved as a new version.",
          "Try an idea starts a separate line of versions you can keep or drop.",
        ],
      },
      {
        id: "look",
        title: "See what a version changed on screen",
        icon: "Eye",
        summary: "Forge takes a picture of every page with each version and marks the pages that look different.",
        body: [
          "Under Versions, a version says how many pages look different from the one before. Look opens the pictures: before and after, side by side, at desktop and phone size.",
          "Differences shows the earlier picture faded with every changed pixel in pink, which is the quickest way to spot a change you didn't ask for.",
          "Pictures are kept for the latest 40 versions. Pages with a changing address (such as /orders/123) and content that changes by itself (a clock, random data) aren't compared reliably.",
        ],
      },
      {
        id: "spec",
        title: "The spec: what the app must keep doing",
        icon: "ScrollText",
        summary: "A summary and a list of acceptance criteria that the agent keeps current and QA tests against.",
        body: [
          "The Spec tab holds a short summary of the app and its acceptance criteria: things a user can do or see, grouped by area. The agent adds and updates them when its work changes what the app does, and has to keep every one true.",
          "Write tests asks the QA agent to walk through criteria that have no test and save a test for each one that works. A criterion with a test shows Passing or Failing after every new version; Fix hands a failing one to the agent.",
          "You can add, edit and remove criteria yourself. For an existing app without a spec, Write the spec from the app has the agent read the app and write it down.",
          "Projects made in Forge also get the spec as docs/SPEC.md with every saved version, so it reaches GitHub with the code.",
        ],
      },
      {
        id: "health",
        title: "Health: problems, tests and security",
        icon: "HeartPulse",
        summary: "See errors from the running app, saved tests and a security scan.",
        body: [
          "Problems lists errors seen in the browser and on the server. Fix this (or Fix all) hands them to the agent.",
          "Saved tests replay after every version. Test the app sends a QA agent through the app in a real browser; Auto-test does this after each version within a daily budget.",
          "Security scans every version for leaked keys and risky code.",
          "Accessibility lists what an automatic scan of every page found (contrast, missing labels, keyboard problems). It never blocks saving; Fix hands a problem to the agent.",
        ],
      },
      {
        id: "comments",
        title: "Comments and review",
        icon: "MessagesSquare",
        summary: "Pin notes to parts of the app and hand them to the agent.",
        body: [
          "Click Comment, then any part of the app, to leave a pinned note. Teammates reply and resolve.",
          "Builders can send a comment to the agent with Ask the agent to fix this.",
        ],
      },
      {
        id: "guest-feedback",
        title: "Feedback from people outside Forge",
        icon: "MessageSquarePlus",
        summary: "Anyone with a preview share link can pin feedback to the app, without an account.",
        body: [
          "More › Share preview link… (above the preview) creates a link. Every active link there has Copy, so you can send it again later. With Let visitors leave feedback on, the page behind it has a Leave feedback button: the visitor clicks a part of the app, writes a note and gives a name.",
          "Their notes appear in Comments marked Guest, pinned to the same element. Reply there and the visitor sees your answer on the shared page; they see only the notes left through their own link.",
          "Builders can remove guest notes. Turning the link off stops new feedback right away.",
        ],
      },
    ],
  },
  {
    id: "team",
    title: "Team, sharing and GitHub",
    blurb: "Roles, sharing projects and pushing code.",
    icon: "Users",
    articles: [
      {
        id: "roles",
        title: "People and roles",
        icon: "Users",
        summary: "Who can see, change and manage what.",
        body: [
          "Workspace roles: admins manage everything, builders create projects, members only see projects shared with them.",
          "Project roles (Share): admins manage access, builders make changes, viewers look around and comment.",
          "Invite people from Team; Forge gives you a link to send.",
        ],
      },
      {
        id: "github",
        title: "GitHub",
        icon: "GitBranch",
        summary: "Push projects to the company organization and import existing repos.",
        body: [
          "Once an admin connects GitHub, Push to GitHub creates a private repository in the organization and pushes the latest version.",
          "Import from GitHub on the home page lists the organization's repositories. Changes to imported projects go back as a pull request.",
          "Pushing needs passing saved tests and a clean security scan; a project admin can override.",
        ],
      },
      {
        id: "github-back",
        title: "Changes and reviews coming back from GitHub",
        icon: "ArrowDownToLine",
        summary: "Bring in what engineers changed on GitHub, and hand review comments to the agent.",
        body: [
          "Once a project has a repository, the GitHub menu shows Changes on GitHub: the commits made there that the project doesn't have. Bring them in merges them into the project.",
          "If they clash with what was built in Forge, the agent resolves the conflicts. Either way the result is saved as a version only when Forge's checks pass; otherwise you can keep fixing or discard it, and nothing is lost on GitHub.",
          "Review feedback lists the pull request's open review comments and failing checks. Tick the ones you want and Send to the agent; when the new version is saved, send it to GitHub from the same menu.",
        ],
        tip: "Bring in GitHub's changes before pushing: Forge never overwrites work that was done on GitHub.",
      },
      {
        id: "library",
        title: "Templates and the component library",
        icon: "Library",
        summary: "Reuse what the team has built.",
        body: [
          "Save as template (in Versions) makes a project a starting point for new ones.",
          "Components saved to the library are available to the agent in every project.",
        ],
      },
      {
        id: "brain",
        title: "Team brain and project notes",
        icon: "Brain",
        summary: "Guidelines the agent follows everywhere, or in one project.",
        body: [
          "Team brain holds company-wide rules (brand, tone, conventions). The Brain tab holds notes for one project.",
          "The agent reads both before every request.",
        ],
      },
    ],
  },
  {
    id: "data",
    title: "Data, APIs and secrets",
    blurb: "Connect apps to company systems safely.",
    icon: "Database",
    articles: [
      {
        id: "apis",
        title: "Company APIs",
        icon: "Plug",
        summary: "Register an API once; apps call it without ever seeing its keys.",
        body: [
          "An admin adds an API in API connections from its OpenAPI spec (link, upload or paste) and sets how it signs in.",
          "In a project, APIs & data picks which APIs the app may use. Forge signs every call, so keys never reach the app's code.",
        ],
      },
      {
        id: "datasources",
        title: "Data sources",
        icon: "Database",
        summary: "Read-only access to databases, spreadsheets and Flowkite.",
        body: [
          "Admins add Postgres, SQL Server, MySQL, spreadsheets or Flowkite under Data sources, then pick them per project in APIs & data.",
          "Apps can only read. Each source has a details page with its tables and a query console.",
        ],
      },
      {
        id: "secrets",
        title: "Secrets",
        icon: "KeyRound",
        summary: "Keys and settings the running app needs.",
        body: [
          "Store them under Secrets. They're encrypted, given only to the running app, and never shown again.",
          "Use test or development keys, not production ones.",
        ],
      },
    ],
  },
];

export const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ["⌘", "K"], what: "Go to a project or page" },
  { keys: ["Enter"], what: "Send (or queue while the agent works)" },
  { keys: ["Shift", "Enter"], what: "New line in the prompt box" },
  { keys: ["⌥", "P"], what: "Switch mode (Build, Chat, Plan, Design)" },
  { keys: ["@"], what: "Add a page or file as context" },
  { keys: ["⌘", "V"], what: "Paste a screenshot to attach it" },
  { keys: ["Esc"], what: "Close menus and dialogs" },
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Why wasn't my change saved as a version?",
    a: "Forge saves only when its checks pass. The agent keeps fixing failures; if it can't, the chat shows “These changes are not saved yet”, where you can ask it to keep fixing or discard the changes.",
  },
  {
    q: "Why does a version say pages look different when I only changed one thing?",
    a: "Shared parts such as a header or a colour appear on many pages, so one change can show on all of them. Open Look and switch to Differences to see exactly which pixels changed.",
  },
  {
    q: "Can I undo something the agent did?",
    a: "Yes. Open Versions and restore the version from before. Nothing is deleted; the restore becomes a new version.",
  },
  {
    q: "Does the agent see our passwords or API keys?",
    a: "No. Secrets, API connections and data sources are handled by Forge; the agent and the app's code never see the keys.",
  },
  {
    q: "The preview says it's reconnecting. What do I do?",
    a: "Usually nothing: it comes back on its own in a few seconds. If it doesn't, press Try again now, or More › Restart the app server.",
  },
  {
    q: "Which model should I use?",
    a: "The default suits most work. Use a cheaper model for small text or style changes, and a stronger one for new pages, data models or tricky bugs.",
  },
];
