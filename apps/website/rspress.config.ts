import { fileURLToPath } from "node:url";
import { defineConfig } from "@rspress/core";
import { pageMeta } from "./components/features-page/content.ts";
import { definingSentence, getStarted, pageTitle } from "./components/landing/content.ts";
import { llmsTxt } from "./components/llms-txt.ts";
import { pageHead, repositoryUrl, siteOrigin } from "./components/site.ts";

/** Resolves a path inside this package. */
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The docs sidebar, in reading order: where to start, the guides, then the reference. */
const sidebar = [
  {
    text: "Docs",
    items: [
      { text: "Overview", link: "/docs/" },
      { text: "Get started", link: "/docs/getting-started" },
      { text: "Features", link: "/docs/features" },
      { text: "Agent support", link: "/docs/agent-support" },
    ],
  },
  {
    text: "Guides",
    items: [
      { text: "Add a source", link: "/docs/guides/add-a-source" },
      { text: "Move an existing setup into Tack", link: "/docs/guides/migrate" },
      { text: "Onboard a team", link: "/docs/guides/team-onboarding" },
      { text: "Get a teammate's new skill", link: "/docs/guides/team-source" },
      { text: "Write a skill", link: "/docs/guides/write-a-skill" },
      { text: "Choose what each project gets", link: "/docs/guides/choose-skills" },
      { text: "Link docs into a project", link: "/docs/guides/link-docs" },
      { text: "Add a document", link: "/docs/guides/write-a-document" },
      { text: "Run a script", link: "/docs/guides/run-a-script" },
      { text: "Share a fixed set with a profile", link: "/docs/guides/profiles" },
      { text: "Add a worktree or clone", link: "/docs/guides/worktrees" },
      { text: "Add or turn off an agent", link: "/docs/guides/agents" },
      { text: "Import skills from GitHub", link: "/docs/guides/import-skills" },
      { text: "Check health", link: "/docs/guides/check-health" },
      { text: "Remove a source, a project or Tack", link: "/docs/guides/remove" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Setup, state and upgrades", link: "/docs/reference/setup" },
      { text: "Source format", link: "/docs/reference/tack-yaml" },
      { text: "Projects and selection", link: "/docs/reference/selection" },
      { text: "Sync and status", link: "/docs/reference/sync" },
      { text: "Docs and the reader", link: "/docs/reference/docs" },
      { text: "Scripts", link: "/docs/reference/scripts" },
      { text: "Profiles and bundles", link: "/docs/reference/profiles" },
      { text: "Skill imports", link: "/docs/reference/import" },
      { text: "Automation", link: "/docs/reference/automation" },
    ],
  },
];

/** Every page of the sidebar, in its order, which `llms.txt` keeps. */
const sidebarLinks = sidebar.flatMap((group) => group.items.map((item) => item.link));

export default defineConfig({
  root: local("./docs"),
  outDir: local("./dist"),
  title: "Tack",
  siteOrigin,
  description: definingSentence,
  icon: "/favicon.svg",
  logo: "/favicon.svg",
  logoText: "tack",
  globalStyles: local("./styles/site.css"),
  route: { cleanUrls: true },
  head: [...pageHead],
  // Writes llms.txt, llms-full.txt and a Markdown twin beside every HTML page.
  llms: {
    llmsTxt: llmsTxt({
      details: `This is Tack, the CLI published on npm as \`@tackup/cli\`, with its source at ${repositoryUrl}. Install it with \`${getStarted.commands[0]}\`, then run \`tack guide onboarding\` and follow it.`,
      pages: [
        { routePath: "/", markdown: "/index.md", title: pageTitle, description: definingSentence },
        { routePath: "/features", markdown: "/features.md", ...pageMeta },
      ],
      order: ["/", "/features", ...sidebarLinks],
    }),
  },
  themeConfig: {
    // Dark is the site default; the warm paper light theme is the alternate.
    darkMode: "dark",
    nav: [
      { text: "Features", link: "/features" },
      { text: "Docs", link: "/docs/" },
    ],
    sidebar: { "/docs/": sidebar },
  },
});
