import { readFile } from "node:fs/promises";
import type { ReaderDocument, ReaderProjectCorpus } from "../types.ts";
import { isDocsIconName, type DocsIconName } from "./catalog.ts";
import {
  checkDocumentIcons,
  documentIconUses,
  moduleIconNames,
  type IconFinding,
} from "./usage.ts";

/** An `<Icon>` of a served document that the reader cannot draw, for the issue popover. */
export type DocumentIconIssue = IconFinding;

/** Every unusable `<Icon>` of the corpus's documents, by path and line, in document order. */
export function corpusIconIssues(documents: readonly ReaderDocument[]): DocumentIconIssue[] {
  return documents.flatMap((document) => checkDocumentIcons(document.source, document.path));
}

/**
 * The docs icons a reader generation must bundle: every valid name the documents pass to `<Icon>`,
 * and every one written in the modules that render them (the customization modules and the
 * components their blocks are implemented by). A module that cannot be read adds nothing.
 */
export async function corpusIconNames(corpus: ReaderProjectCorpus): Promise<DocsIconName[]> {
  const modules = new Set([
    ...corpus.resources.flatMap(({ config }) =>
      [config?.navigation.module, config?.layouts.module, config?.components.module].flatMap(
        (path) => path ?? [],
      ),
    ),
    ...corpus.documents.flatMap((document) =>
      document.blocks.flatMap((block) => (block.implementations ?? []).map(({ path }) => path)),
    ),
  ]);
  const moduleNames = await Promise.all(
    [...modules].map(async (path) =>
      readFile(path, "utf8").then(moduleIconNames, (): readonly string[] => []),
    ),
  );
  const names = [
    ...corpus.documents.flatMap((document) =>
      documentIconUses(document.source, document.path).flatMap(({ name }) => name ?? []),
    ),
    ...moduleNames.flat(),
  ];
  return [...new Set(names.filter(isDocsIconName))].toSorted();
}

/**
 * The module a reader generation imports its docs icons from: each icon from its own Lucide
 * module, so the bundle holds only those, and one map from name to component.
 *
 * @param iconsDirectory - lucide-react's directory of per-icon ES modules.
 */
export function iconModuleSource(names: readonly string[], iconsDirectory: string): string {
  return [
    "// The docs icons this reader generation draws, imported one module each.",
    ...names.map(
      (name, index) =>
        `import icon${index} from ${JSON.stringify(`${iconsDirectory}/${name}.mjs`)};`,
    ),
    "",
    `export const icons = { ${names.map((name, index) => `${JSON.stringify(name)}: icon${index}`).join(", ")} };`,
    "",
  ].join("\n");
}
