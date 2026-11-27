/** One tag of a page's `head` frontmatter, as Rspress renders it: a tag name and its props. */
export type HeadTag =
  | readonly ["title", { readonly children: string }]
  | readonly ["meta", Record<string, string>]
  | readonly ["script", { readonly type: string; readonly children: string }];

/**
 * The head tags that give a custom page its own title and description. Rspress gives a custom page
 * the site's title and description, and leaves out any tag the page's `head` already names, so a
 * page that sets these is shown, searched and shared under its own words.
 */
export const socialHead = ({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}): ReadonlyArray<HeadTag> => [
  ["title", { children: title }],
  ["meta", { property: "og:title", content: title }],
  ["meta", { name: "description", content: description }],
  ["meta", { property: "og:description", content: description }],
];
