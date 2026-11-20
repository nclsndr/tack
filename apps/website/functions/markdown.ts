/**
 * Content negotiation for the static site: a request whose `Accept` header names `text/markdown`
 * gets the Markdown twin that Rspress writes beside each HTML page.
 */

/** Whether an `Accept` header asks for Markdown with a non-zero quality. */
export function prefersMarkdown(accept: string | null) {
  if (accept === null) return false;
  return accept.split(",").some((range) => {
    const [type, ...parameters] = range.split(";").map((part) => part.trim().toLowerCase());
    if (type !== "text/markdown") return false;
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

/**
 * The path of a page's Markdown twin, or `undefined` when the path is not a page: a file with an
 * extension other than `.html`, including the Markdown twins themselves.
 */
export function markdownPath(pathname: string) {
  if (pathname.endsWith("/") === true) return `${pathname}index.md`;
  const name = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (name.endsWith(".html") === true) return `${pathname.slice(0, -".html".length)}.md`;
  if (name.includes(".") === true) return undefined;
  return `${pathname}.md`;
}
