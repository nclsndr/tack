import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReaderProjectInput } from "./types.ts";

const words =
  "reader document architecture navigation source resource boundary runtime testing design".split(
    " ",
  );

/**
 * Writes a plain Markdown docs resource of linked notes into a new temporary directory, shaped like
 * the corpus used to diagnose idle reader traffic but small enough for unit tests.
 */
export async function generatedCorpus(notes = 24): Promise<ReaderProjectInput> {
  const root = await mkdtemp(join(tmpdir(), "tack-reader-generated-"));
  const docs = join(root, "docs");
  await mkdir(docs);
  await Promise.all(
    Array.from({ length: notes }, (_, index) => {
      const name = (offset: number) => `note-${String((index + offset) % notes).padStart(3, "0")}`;
      const paragraphs = Array.from({ length: 8 }, (_unused, paragraph) =>
        Array.from(
          { length: 40 },
          (_word, word) => words[(index + paragraph + word) % words.length],
        )
          .join(" ")
          .concat("."),
      );
      return writeFile(
        join(docs, `${name(0)}.md`),
        [`# Note ${index}`, `[Next note](${name(1)}.md)`, ...paragraphs].join("\n\n") + "\n",
      );
    }),
  );
  return {
    project: { name: "Generated notes", root },
    resources: [
      { sourceRegistrationId: "generated", name: "notes", sourcePath: root, directoryPath: docs },
    ],
    issues: [],
  };
}
