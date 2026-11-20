import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, loadReaderConfig, searchDocuments } from "@tackup/reader/search";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("reader search corpus entry", () => {
  it("searches included pages and imported data with saved physical citations on every load", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tack-reader-search-")));
    temporary.push(root);
    await mkdir(join(root, "reader"));
    await writeFile(
      join(root, "tack.reader.yaml"),
      stringify({
        version: 1,
        content: [{ root: "reader", include: ["*.mdx"], exclude: ["fragment.mdx"] }],
        navigation: { preset: "folders" },
        layouts: { preset: "reader" },
        components: { preset: "standard" },
        metadata: { preset: "working-docs" },
      }),
    );
    const page = join(root, "reader/page.mdx");
    const fragment = join(root, "reader/fragment.mdx");
    const data = join(root, "reader/data.ts");
    await Promise.all([
      writeFile(
        page,
        '---\ntitle: Search host\n---\n\nimport Fragment from "./fragment.mdx"\n\n<Fragment />\n',
      ),
      writeFile(fragment, 'import { steps } from "./data.ts"\n\n<Walkthrough steps={steps} />\n'),
      writeFile(data, 'export const steps = [{ title: "Hidden needle" }];\n'),
    ]);
    const config = await loadReaderConfig(root);
    const first = searchDocuments(await loadCorpus(config), { query: "hidden needle" });
    expect(first.total).toBe(1);
    expect(first.hits[0]!.document).toMatchObject({
      path: page,
      relativePath: "reader/page.mdx",
      route: "/reader/page",
    });
    const match = first.hits[0]!.matches.find((entry) => entry.source.path === fragment);
    expect(match).toMatchObject({
      id: `${fragment}:3:3`,
      source: { path: fragment, startLine: 3, endLine: 3 },
      contributors: [
        { path: data, startLine: 1, endLine: 1, kind: "data" },
        { path: page, startLine: 7, endLine: 7 },
      ],
    });
    expect(match!.excerpt).toContain("Hidden needle");
    await writeFile(data, 'export const steps = [{ title: "Updated needle" }];\n');
    const documents = await loadCorpus(config);
    expect(searchDocuments(documents, { query: "hidden needle" }).total).toBe(0);
    const updated = searchDocuments(documents, { query: "updated needle" }).hits[0]!.matches.find(
      (entry) => entry.source.path === fragment,
    );
    expect(updated!.id).toBe(match!.id);
    expect(updated!.version).not.toBe(match!.version);
  });
});
