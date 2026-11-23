import { fileURLToPath } from "node:url";
import { defineConfig } from "@rspress/core";
import { definingSentence } from "./components/landing/content.ts";

/** Resolves a path inside this package. */
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: local("./docs"),
  outDir: local("./dist"),
  title: "Tack",
  description: definingSentence,
  icon: "/favicon.svg",
  logo: "/favicon.svg",
  logoText: "tack",
  globalStyles: local("./styles/site.css"),
  route: { cleanUrls: true },
  // Writes llms.txt, llms-full.txt and a Markdown twin beside every HTML page.
  llms: true,
  themeConfig: {
    // Dark is the site default; the warm paper light theme is the alternate.
    darkMode: "dark",
    nav: [
      { text: "Features", link: "/features" },
      { text: "Docs", link: "/docs/" },
    ],
    sidebar: {
      "/docs/": [
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
      ],
    },
  },
});
