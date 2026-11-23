import { definingSentence, pageTitle } from "../components/landing/content.ts";
import { Landing } from "../components/landing/landing.tsx";
import { socialHead } from "../components/social-head.ts";

/**
 * The landing page renders without the docs navigation, sidebar or outline. A custom page takes
 * the site's title and description in its head, so its own go in `head`.
 */
export const frontmatter = {
  pageType: "custom",
  navbar: false,
  title: pageTitle,
  description: definingSentence,
  head: socialHead({ title: pageTitle, description: definingSentence }),
};

export default function Index() {
  return <Landing />;
}
