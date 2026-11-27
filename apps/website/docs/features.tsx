import { pageMeta } from "../components/features-page/content.ts";
import { FeaturesPage } from "../components/features-page/features-page.tsx";
import { socialHead } from "../components/social-head.ts";

const { title, description } = pageMeta;

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
