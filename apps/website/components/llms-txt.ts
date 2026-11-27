import type { LlmsTxtContext } from "@rspress/core";

/**
 * A page Rspress lists without its own title and description, or does not list at all: the two
 * custom pages. `markdown` is the path of its Markdown twin.
 */
type OwnPage = {
  readonly routePath: string;
  readonly markdown: string;
  readonly title: string;
  readonly description: string;
};

/** One line of `llms.txt`: a page, its twin's address and what it answers. */
type Entry = {
  readonly routePath: string;
  readonly link: string;
  readonly title: string;
  readonly description?: string | undefined;
};

/** The sections of `llms.txt`, in order; a page goes to the first whose prefix its route has. */
const sections = [
  { title: "Guides", prefix: "/docs/guides/" },
  { title: "Reference", prefix: "/docs/reference/" },
  { title: "Start here", prefix: "/" },
] as const;

/** The order the sections print in. */
const sectionOrder = ["Start here", "Guides", "Reference"] as const;

const line = (entry: Entry) =>
  `- [${entry.title}](${entry.link})${entry.description === undefined ? "" : `: ${entry.description}`}`;

/**
 * Renders `llms.txt` for coding agents: the defining sentence, how to install, then every page by
 * the question it answers, starting with the landing page, which Rspress leaves out. Links are
 * absolute, so they still lead somewhere when an agent keeps the text and drops the URL.
 *
 * @param details - Lines under the summary: what an agent needs before it opens a page.
 * @param pages - Pages whose title and description Rspress cannot read, added or replaced.
 * @param order - Route paths in the order of the sidebar; a page not in it follows the others of
 *   its section.
 */
export const llmsTxt =
  ({
    details,
    pages,
    order,
  }: {
    readonly details: string;
    readonly pages: ReadonlyArray<OwnPage>;
    readonly order: ReadonlyArray<string>;
  }) =>
  (context: LlmsTxtContext): string => {
    const origin = context.siteOrigin ?? "";
    const own = new Map(
      pages.map((page) => [
        page.routePath,
        { ...page, link: `${origin}${page.markdown}` } satisfies Entry,
      ]),
    );
    const listed: ReadonlyArray<Entry> = context.sections.flatMap((section) =>
      section.pages.map((page) => own.get(page.routePath) ?? page),
    );
    const added = [...own.values()].filter(
      (entry) => listed.some((page) => page.routePath === entry.routePath) === false,
    );
    const rank = (entry: Entry) => {
      const index = order.indexOf(entry.routePath);
      return index === -1 ? order.length : index;
    };
    const entries = [...added, ...listed].toSorted((left, right) => rank(left) - rank(right));
    const sectionOf = (entry: Entry) =>
      sections.find((section) => entry.routePath.startsWith(section.prefix))?.title;
    const body = sectionOrder
      .map((title) => ({ title, entries: entries.filter((entry) => sectionOf(entry) === title) }))
      .filter((section) => section.entries.length > 0)
      .map((section) => `## ${section.title}\n\n${section.entries.map(line).join("\n")}\n`)
      .join("\n");
    return `# ${context.title ?? ""}\n\n> ${context.description ?? ""}\n\n${details}\n\n${body}`;
  };
