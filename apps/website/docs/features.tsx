import { FeaturesPage } from "../components/features-page/features-page.tsx";

/** The features page renders without the docs navigation, sidebar or outline, as the landing does. */
export const frontmatter = {
  pageType: "custom",
  navbar: false,
  title: "Tack features: every capability, with real output",
  description:
    "Every Tack capability in one catalogue, each with the real terminal output of the command that delivers it.",
};

export default function Features() {
  return <FeaturesPage />;
}
