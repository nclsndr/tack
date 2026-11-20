import { Landing } from "../components/landing/landing.tsx";

/** The landing page renders without the docs navigation, sidebar or outline. */
export const frontmatter = {
  pageType: "custom",
  navbar: false,
  title: "Tack: One setup. Every coding agent.",
  description:
    "Write a skill once, in a folder you own or share. Tack links it wherever your agents look, for you and for every project and worktree.",
};

export default function Index() {
  return <Landing />;
}
