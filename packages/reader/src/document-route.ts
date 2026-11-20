/** A route without a trailing `/index` or `/`: Rspress serves `a/index` at `a/`. */
const folded = (path: string): string => path.replace(/\/index$/, "").replace(/\/$/, "");

/**
 * The document the reader shows at `pathname`: the one whose route it is, an index document also
 * at its folder path, and the first document at the root.
 */
export function documentAt<Document extends { readonly route: string }>(
  documents: readonly Document[],
  pathname: string,
): Document | undefined {
  if (pathname === "/") return documents.find((document) => document.route === "/") ?? documents[0];
  return (
    documents.find((document) => document.route === pathname) ??
    documents.find((document) => folded(document.route) === folded(pathname))
  );
}
