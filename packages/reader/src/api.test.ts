import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeDocument } from "./source.ts";
import { copyFromCorpus, corpusRevision, editorUrl } from "./api.ts";
const document = analyzeDocument(
  "/repo/page.mdx",
  "---\ntitle: Reader\n---\n# First\n\nSaved paragraph.\n",
);
describe("copy API", () => {
  it("copies physical authored ranges and readable selected content with state", async () => {
    const block = document.blocks[1]!;
    expect(
      await copyFromCorpus([document], {
        blocks: [{ id: block.id, version: block.version }],
        readable: "Saved",
        mode: "readable",
        state: { step: 2 },
      }),
    ).toContain("/repo/page.mdx:6-6");
    expect(
      await copyFromCorpus([document], {
        blocks: [{ id: block.id, version: block.version }],
        mode: "raw",
      }),
    ).toContain("Saved paragraph.");
  });
  it("uses readable copy when the optional mode is omitted", async () => {
    const block = document.blocks[1]!;
    expect(
      await copyFromCorpus([document], {
        blocks: [{ id: block.id, version: block.version }],
        readable: "Readable default",
      }),
    ).toContain("Readable default");
  });
  it("refuses stale saved content and unknown blocks", async () => {
    await expect(
      copyFromCorpus([document], { blocks: [{ id: document.blocks[0]!.id, version: "old" }] }),
    ).rejects.toThrow("changed");
    await expect(
      copyFromCorpus([document], { blocks: [{ id: "missing", version: "x" }] }),
    ).rejects.toThrow("changed");
  });
  it("validates request data and refuses empty selection", async () => {
    await expect(copyFromCorpus([document], {})).rejects.toThrow();
    await expect(copyFromCorpus([document], { blocks: [] })).rejects.toThrow();
  });
  it("uses the rendered resource context when matching a shared physical block", async () => {
    const privateDocument = {
      ...document,
      resource: {
        sourceRegistrationId: "private-source",

        name: "docs",
        sourcePath: "/private/source",
      },
    };
    const sharedDocument = {
      ...document,
      resource: {
        sourceRegistrationId: "shared-source",

        name: "docs",
        sourcePath: "/shared/source",
      },
    };
    const block = document.blocks[0]!;
    const output = await copyFromCorpus([privateDocument, sharedDocument], {
      blocks: [{ id: block.id, version: block.version }],
      mode: "reference",
      resource: sharedDocument.resource,
    });
    expect(output).toContain("docs (shared-source)");
    expect(output).not.toContain("docs (private-source)");
  });
  it("changes revision for metadata, source ranges, and contributed raw data", () => {
    expect(corpusRevision([document])).not.toBe(
      corpusRevision([{ ...document, source: document.source + "\n" }]),
    );
    expect(corpusRevision([document])).not.toBe(
      corpusRevision([
        { ...document, blocks: document.blocks.map((block) => ({ ...block, version: "changed" })) },
      ]),
    );
    const unavailable = {
      resource: { sourceRegistrationId: "missing-source", name: "docs" },
      sourcePath: "/sources/missing",
      code: "attachment-missing",
      message: "The attached docs resource is unavailable.",
    };
    expect(corpusRevision([document], [unavailable])).not.toBe(corpusRevision([document]));
    expect(corpusRevision([document], [unavailable])).not.toBe(
      corpusRevision(
        [document],
        [
          {
            ...unavailable,
            resource: { ...unavailable.resource, sourceRegistrationId: "other-source" },
          },
        ],
      ),
    );
    expect(corpusRevision([document], [unavailable])).not.toBe(
      corpusRevision([document], [{ ...unavailable, message: "The source moved." }]),
    );
  });
  it("builds an encoded editor URL only for a corpus document", () => {
    expect(editorUrl([document], document.path, 6)).toBe("vscode://file/repo/page.mdx:6");
    expect(() => editorUrl([document], "/elsewhere", 1)).toThrow("declared");
  });
});

it("includes saved imported data and optional implementation context in raw copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "tack-reader-copy-"));
  try {
    const path = join(root, "data.ts");
    await writeFile(path, "export const points = [91, 79];\n");
    const implementation = join(root, "visual.tsx");
    await writeFile(implementation, "export const Visual = () => null;\n");
    const block = document.blocks[0]!;
    const enriched = {
      ...document,
      blocks: [
        {
          ...block,
          contributors: [{ path, startLine: 1, endLine: 1, kind: "data" as const }],
          implementations: [
            { path: implementation, startLine: 1, endLine: 1, kind: "implementation" as const },
          ],
        },
      ],
    };
    const output = await copyFromCorpus([enriched], {
      blocks: [{ id: block.id, version: block.version }],
      mode: "raw",
      includeImplementations: true,
    });
    expect(output).toContain("export const points = [91, 79]");
    expect(output).toContain("export const Visual = () => null;");
    expect(editorUrl([enriched], block.source.path, 0)).toBe("vscode://file/repo/page.mdx:1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
