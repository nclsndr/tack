import { relative } from "node:path";
import { checkDocumentComponents } from "./authoring/check.ts";
import { corpusIconIssues } from "./icons/collect.ts";
import { resourceIdentity } from "./resource.ts";
import { readerRevision } from "./routes.ts";
import type { ReaderBoot } from "./runtime.tsx";
import type { ReaderCheckout, ReaderProjectCorpus, ReaderProjectInput } from "./types.ts";

/**
 * Builds the payload a compiled reader generation boots with in the browser.
 * @param options.generation - The compiled generation; with the corpus it fixes the revision the
 * status route reports once that generation is published.
 * @param options.checkout - What the project root had checked out when the generation compiled.
 * The status route keeps it fresh afterwards.
 * @param options.version - The Tack release stamp the CLI passed, left out when none was passed.
 */
export function readerBoot(options: {
  input: ReaderProjectInput;
  corpus: ReaderProjectCorpus;
  generation: string;
  token: string;
  checkout: ReaderCheckout | null;
  version?: string | undefined;
}): ReaderBoot {
  const { input, corpus } = options;
  const { documents } = corpus;
  return {
    worktree: input.project.root,
    project: { name: input.project.name },
    resources: corpus.resources.map(({ resource }) => ({
      sourceRegistrationId: resource.sourceRegistrationId,
      name: resource.name,
      sourcePath: resource.sourcePath,
      directoryPath: resource.directoryPath,
    })),
    checkout: options.checkout,
    ...(options.version === undefined ? {} : { version: options.version }),
    metadata: {
      types: [...new Set(documents.flatMap((document) => document.metadata.type ?? []))],
      statuses: [...new Set(documents.flatMap((document) => document.metadata.status ?? []))],
      tags: [...new Set(documents.flatMap((document) => document.metadata.tags))],
    },
    documents,
    issues: corpus.issues,
    iconIssues: corpusIconIssues(documents),
    componentIssues: documents.flatMap(
      (document) => checkDocumentComponents(document.source, document.path).findings,
    ),
    complete: corpus.complete,
    revision: readerRevision(corpus, options.generation),
    token: options.token,
    presets: {
      navigation: "folders",
      layouts: "reader",
      components: "standard",
    },
    archive: corpus.resources.flatMap(({ resource, config }) =>
      (config?.navigation.archive ?? []).map(
        (folder) => `${resourceIdentity(resource)}:${relative(resource.directoryPath, folder)}`,
      ),
    ),
  };
}
