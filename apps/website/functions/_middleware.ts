import { markdownPath, prefersMarkdown } from "./markdown.ts";

/** The part of the Cloudflare Pages Functions context this middleware uses. */
type PagesContext = {
  readonly request: Request;
  readonly env: { readonly ASSETS: { fetch(request: Request | URL): Promise<Response> } };
  next(): Promise<Response>;
};

/**
 * Serves the Markdown twin of a page to clients that send `Accept: text/markdown`, such as coding
 * agents. Every other request, and any page without a twin, goes to the static site unchanged.
 */
export async function onRequest(context: PagesContext) {
  const url = new URL(context.request.url);
  const twin = markdownPath(url.pathname);
  if (twin === undefined || prefersMarkdown(context.request.headers.get("Accept")) === false)
    return context.next();
  const markdown = await context.env.ASSETS.fetch(new URL(twin, url));
  if (markdown.ok === false) return context.next();
  return new Response(markdown.body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept" },
  });
}
