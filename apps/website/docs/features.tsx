import { FeaturesPage } from "../components/features-page/features-page.tsx";

/** The features page renders without the docs navigation, sidebar or outline, like the landing. */
export const frontmatter = {
  pageType: "custom",
  navbar: false,
  title: "Tack features: from first setup to day two",
  description:
    "Every Tack feature, step by step: set up the machine, add a source, pick, sync into Claude Code, Codex, Cursor, OpenCode and Pi, attach docs, run scripts and pin profiles.",
};

export default function Features() {
  return <FeaturesPage />;
}
