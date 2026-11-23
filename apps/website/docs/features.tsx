import { FeaturesPage } from "../components/features-page/features-page.tsx";
import { socialHead } from "../components/social-head.ts";

const title = "Tack features: every part, every command";
const description =
  "Every Tack feature, by what you care about: your sources and your team's in one setup, every project and worktree, every agent, a fixed set for a CI runner, docs and scripts.";

/**
 * The features page renders without the docs navigation, sidebar or outline, as the landing does,
 * and carries its own title and description in its head.
 */
export const frontmatter = {
  pageType: "custom",
  navbar: false,
  title,
  description,
  head: socialHead({ title, description }),
};

export default function Features() {
  return <FeaturesPage />;
}
