import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReaderDocument } from "./types.ts";

type ReaderPage = { routePath: string; filepath: string } | { routePath: string; content: string };

/** Keeps router preloading independent of authored module evaluation, which belongs inside the reader boundary. */
export async function writePageProxies(
  directory: string,
  documents: readonly ReaderDocument[],
): Promise<ReaderPage[]> {
  if (documents.length === 0)
    return [{ routePath: "/", content: "---\ntitle: No declared documents\n---\n" }];
  await mkdir(directory, { recursive: true });
  const pages = await Promise.all(
    documents.map(async (document, index) => {
      const filepath = join(directory, `page-${index}.tsx`);
      await writeFile(
        filepath,
        `import { lazy } from "react";
const SourceDocument = lazy(() => import(/* webpackChunkName: "tack-document-${index}" */ ${JSON.stringify(document.path)}));
export const title = ${JSON.stringify(document.title)};
export const frontmatter = ${JSON.stringify(document.metadata)};
export default function ReaderPage() { return <SourceDocument />; }
`,
      );
      return { routePath: document.route, filepath };
    }),
  );
  const first = pages[0];
  return first === undefined ? pages : [...pages, { routePath: "/", filepath: first.filepath }];
}
