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
          ],
        },
      ],
    },
  },
});
