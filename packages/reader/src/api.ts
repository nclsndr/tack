import { readFile } from "node:fs/promises";
import { z } from "zod";
import { formatCopy, sourceVersion } from "./source.ts";
import type { ReaderDocument, ReaderDocumentResource, ReaderResourceIssue } from "./types.ts";

const resource = z.strictObject({
  sourceRegistrationId: z.string(),
  name: z.string(),
  sourcePath: z.string(),
});
const copyRequest = z.strictObject({
  blocks: z.array(z.strictObject({ id: z.string(), version: z.string() })).min(1),
  readable: z.string().optional(),
  mode: z.enum(["readable", "raw", "reference"]).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  includeImplementations: z.boolean().optional(),
  resource: resource.optional(),
});

function sameResource(left: ReaderDocumentResource | undefined, right: ReaderDocumentResource) {
  return (
    left?.sourceRegistrationId === right.sourceRegistrationId &&
    left.name === right.name &&
    left.sourcePath === right.sourcePath
  );
}

/** Refuses stale rendered blocks before formatting a prompt from newly saved source. */
export async function copyFromCorpus(documents: ReaderDocument[], input: unknown): Promise<string> {
  const request = copyRequest.parse(input);
  const selectedResource = request.resource;
  const selected = request.blocks.map((reference) => {
    const documentsWithBlock = documents.filter((document) =>
      document.blocks.some(
        (candidate) => candidate.id === reference.id && candidate.version === reference.version,
      ),
    );
    const matchingDocuments =
      selectedResource === undefined
        ? documentsWithBlock
        : documentsWithBlock.filter((document) =>
            sameResource(document.resource, selectedResource),
          );
    const document = matchingDocuments[0];
    if (document === undefined)
      throw new Error(
        "Source changed. Wait for the live reader to reload, then select and copy again.",
      );
    const block = document.blocks.find(
      (candidate) => candidate.id === reference.id && candidate.version === reference.version,
    );
    // Coverage skip: documentsWithBlock only contains documents with the exact selected block.
    /* v8 ignore next -- @preserve */
    if (block === undefined)
      throw new Error(
        "Source changed. Wait for the live reader to reload, then select and copy again.",
      );
    return { block, document };
  });
  const blocks = selected.map((entry) => entry.block);
  const references = blocks.flatMap((block) => [
    ...block.contributors,
    ...(request.includeImplementations === true ? (block.implementations ?? []) : []),
  ]);
  const sources =
    request.mode === "raw"
      ? Object.fromEntries(
          await Promise.all(
            references.map(async (reference) => [
              reference.path,
              await readFile(reference.path, "utf8"),
            ]),
          ),
        )
      : {};
  return formatCopy({
    blocks,
    sources,
    ...(request.readable === undefined ? {} : { readable: request.readable }),
    ...(request.mode === undefined ? {} : { mode: request.mode }),
    ...(request.state === undefined ? {} : { state: request.state }),
    ...(request.includeImplementations === undefined
      ? {}
      : { includeImplementations: request.includeImplementations }),
    resources: selected.flatMap((entry) =>
      entry.document.resource === undefined ? [] : [entry.document.resource],
    ),
  });
}

/** Identifies all saved source and contributor revisions used to render a corpus. */
export function corpusRevision(
  documents: ReaderDocument[],
  issues: ReaderResourceIssue[] = [],
): string {
  return sourceVersion(
    JSON.stringify({
      documents: documents.map((document) => ({
        path: document.path,
        resource: document.resource,
        source: document.source,
        versions: document.blocks.map((block) => block.version),
      })),
      issues,
    }),
  );
}

/** Opens a physical line in VS Code through its registered URL handler. */
export function editorUrl(documents: ReaderDocument[], path: string, line = 1): string {
  if (
    documents.some(
      (document) =>
        document.path === path || document.blocks.some((block) => block.source.path === path),
    ) === false
  )
    throw new Error("Editor target must be a declared document.");
  return `vscode://file${path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}:${Math.max(1, Math.floor(line))}`;
}
