/** Where the site is served. Rspress writes it into the sitemap, `llms.txt` and the twins' links. */
export const siteOrigin = "https://tackup.dev";

/** The public repository, for the footer and the structured data. */
export const repositoryUrl = "https://github.com/nclsndr/tack";

/**
 * A path of the site as an absolute address, for text an agent may keep without the page it came
 * from: a Markdown twin, `llms.txt`.
 */
export const siteUrl = (path: string) => new URL(path, siteOrigin).href;

/**
 * Head tags every page gets from the site config: its canonical address and the same address for a
 * shared link, from the page's route.
 */
export const pageHead: ReadonlyArray<(route: PageRoute) => [string, Record<string, string>]> = [
  ({ routePath }) => ["link", { rel: "canonical", href: siteUrl(routePath) }],
  ({ routePath }) => ["meta", { property: "og:url", content: siteUrl(routePath) }],
];

/** The part of a route the head tags read. */
type PageRoute = { readonly routePath: string };
