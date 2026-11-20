import { fileURLToPath } from "node:url";
import { defineConfig } from "@rspress/core";

/** Resolves a path inside this package. */
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: local("./docs"),
  outDir: local("./dist"),
  title: "Tack",
  description:
    "Tack links the skills, commands and docs you maintain wherever your coding agents look.",
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
    nav: [{ text: "Docs", link: "/docs/" }],
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
