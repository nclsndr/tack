import { FeaturesPage } from "../components/features-page/features-page.tsx";

/** The features page renders without the docs navigation, sidebar or outline, as the landing does. */
export const frontmatter = {
  pageType: "custom",
  navbar: false,
  title: "Tack features: every lens, every command",
  description:
    "Every Tack feature, by what you care about: set up once, reach every agent, per project, docs, scripts and profiles.",
};

export default function Features() {
  return <FeaturesPage />;
}
