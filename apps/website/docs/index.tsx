import { definingSentence, pageTitle } from "../components/landing/content.ts";
import { Landing } from "../components/landing/landing.tsx";
import { socialHead } from "../components/social-head.ts";
import { jsonLd, landingData } from "../components/structured-data.ts";

/**
 * The landing page renders without the docs navigation, sidebar or outline. A custom page takes
 * the site's title and description in its head, so its own go in `head`, with the structured data
 * that names Tack and the questions the page answers.
 */
export const frontmatter = {
  pageType: "custom",
  navbar: false,
  title: pageTitle,
  description: definingSentence,
  head: [...socialHead({ title: pageTitle, description: definingSentence }), jsonLd(landingData)],
};

export default function Index() {
  return <Landing />;
}
