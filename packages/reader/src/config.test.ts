import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReaderConfig, ReaderConfigurationError } from "./config.ts";

const temporary: string[] = [];
const valid = {
  version: 1,
  content: [{ root: "working", include: ["**/*.mdx"], exclude: ["fragments/**"] }],
  navigation: { preset: "folders" },
  layouts: { preset: "reader" },
  components: { preset: "standard" },
  metadata: { preset: "working-docs", tags: ["dogfood"] },
};

async function fixture(value: unknown = valid) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tack-reader-config-")));
  temporary.push(directory);
  await mkdir(join(directory, "working"));
  await writeFile(join(directory, "tack.reader.yaml"), stringify(value));
  return directory;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("explicit reader configuration", () => {
  it("rejects a JSON file reference", async () => {
    const directory = await fixture();
    await writeFile(join(directory, "reader.json"), JSON.stringify(valid));
    await expect(loadReaderConfig(directory, "reader.json")).rejects.toThrow(/\.yaml or \.yml/);
  });
  it("requires the explicitly selected standalone YAML file", async () => {
    const directory = await fixture();
    await rm(join(directory, "tack.reader.yaml"));
    await expect(loadReaderConfig(directory)).rejects.toThrow(/tack.reader.yaml.*required/);
  });

  it("resolves declared locations and explicitly selected preset vocabularies", async () => {
    const directory = await fixture();
    const config = await loadReaderConfig(directory);
    expect(config.content[0]?.root).toBe(join(directory, "working"));
    expect(config.metadata.types).toContain("walkthrough");
    expect(config.metadata.tags).toContain("dogfood");
    expect(config.worktree).toBe(directory);
  });

  it.each([
    { ...valid, content: [] },
    { ...valid, content: [{ root: "working", include: [], exclude: [] }] },
    { ...valid, content: [{ root: "../outside", include: ["**/*.mdx"], exclude: [] }] },
    { ...valid, navigation: {} },
    { ...valid, metadata: {} },
    { ...valid, title: "unknown field" },
    { ...valid, components: { preset: "invented" } },
    { ...valid, navigation: { preset: "folders", archive: [] } },
    { ...valid, navigation: { preset: "folders", archive: ["../outside"] } },
    { ...valid, navigation: { module: "tack.reader.yaml", archive: ["working"] } },
  ])("rejects incomplete, escaping or unknown configuration: %j", async (value) => {
    await expect(loadReaderConfig(await fixture(value))).rejects.toBeInstanceOf(
      ReaderConfigurationError,
    );
  });

  it("resolves declared archive folders for folder navigation", async () => {
    const directory = await fixture({
      ...valid,
      navigation: { preset: "folders", archive: ["working/archive"] },
    });
    await mkdir(join(directory, "working", "archive"));
    const config = await loadReaderConfig(directory);
    expect(config.navigation).toEqual({
      preset: "folders",
      archive: [join(directory, "working", "archive")],
    });
    expect((await loadReaderConfig(await fixture())).navigation).toEqual({ preset: "folders" });
  });

  it("allows explicit custom modules and vocabularies without presets", async () => {
    const directory = await fixture({
      ...valid,
      navigation: { module: "./nav.tsx" },
      layouts: { module: "./layout.tsx" },
      components: { module: "./components.tsx" },
      metadata: { types: ["decision"], statuses: ["proposed"] },
    });
    await Promise.all(
      ["nav.tsx", "layout.tsx", "components.tsx"].map((name) =>
        writeFile(join(directory, name), "export default {}"),
      ),
    );
    const config = await loadReaderConfig(directory);
    expect(config.navigation.module).toBe(join(directory, "nav.tsx"));
    expect(config.metadata).toEqual({ types: ["decision"], statuses: ["proposed"], tags: [] });
  });

  it("reports malformed YAML and missing modules actionably", async () => {
    const directory = await fixture();
    await writeFile(join(directory, "tack.reader.yaml"), "{");
    await expect(loadReaderConfig(directory)).rejects.toThrow(/valid YAML/);
    await writeFile(
      join(directory, "tack.reader.yaml"),
      stringify({ ...valid, components: { module: "absent.tsx" } }),
    );
    await expect(loadReaderConfig(directory)).rejects.toThrow(/absent.tsx/);
  });

  it("treats absent content roots and archive folders as empty until they exist", async () => {
    const directory = await fixture({
      ...valid,
      content: [
        { root: "working", include: ["**/*.mdx"], exclude: [] },
        { root: "later/notes", include: ["**/*.mdx"], exclude: [] },
      ],
      navigation: { preset: "folders", archive: ["working/archive", "later/archive"] },
    });
    const config = await loadReaderConfig(directory);
    expect(config.content.map((entry) => entry.root)).toEqual([
      join(directory, "working"),
      join(directory, "later", "notes"),
    ]);
    expect(config.navigation.archive).toEqual([
      join(directory, "working", "archive"),
      join(directory, "later", "archive"),
    ]);
  });

  it("keeps real errors for optional directories that are files, dangling links, escapes or under files", async () => {
    const directory = await fixture({
      ...valid,
      navigation: { preset: "folders", archive: ["working/archive"] },
    });
    const outside = await fixture();
    const archive = join(directory, "working", "archive");
    await writeFile(archive, "not a directory");
    await expect(loadReaderConfig(directory)).rejects.toThrow(/archive.*must be a directory/);
    await rm(archive);
    await symlink(join(directory, "nowhere"), archive);
    await expect(loadReaderConfig(directory)).rejects.toThrow(/archive.*cannot be read/);
    await rm(archive);
    await symlink(outside, join(directory, "working", "archive"));
    await expect(loadReaderConfig(directory)).rejects.toThrow(/resolves outside/);
    await rm(archive);
    await symlink(outside, join(directory, "escape"));
    await writeFile(
      join(directory, "tack.reader.yaml"),
      stringify({
        ...valid,
        navigation: { preset: "folders", archive: ["escape/later"] },
      }),
    );
    await expect(loadReaderConfig(directory)).rejects.toThrow(/resolves outside/);
    await writeFile(join(directory, "plain"), "file");
    await writeFile(
      join(directory, "tack.reader.yaml"),
      stringify({
        ...valid,
        navigation: { preset: "folders", archive: ["plain/archive"] },
      }),
    );
    await expect(loadReaderConfig(directory)).rejects.toThrow(/plain\/archive/);
  });

  it("reports an optional directory below a dangling link instead of treating it as absent", async () => {
    const directory = await fixture({
      ...valid,
      navigation: { preset: "folders", archive: ["dangling/later/archive"] },
    });
    await symlink(join(directory, "nowhere"), join(directory, "dangling"));
    await expect(loadReaderConfig(directory)).rejects.toThrow(
      "Reader path dangling/later/archive does not exist or cannot be read. Declare an existing content directory.",
    );
  });

  it("rejects a content file, a customization directory, and symlink escapes", async () => {
    const directory = await fixture();
    const outside = await fixture();
    await writeFile(join(directory, "file.mdx"), "title");
    await writeFile(
      join(directory, "tack.reader.yaml"),
      stringify({
        ...valid,
        content: [{ root: "file.mdx", include: ["**/*.mdx"], exclude: [] }],
      }),
    );
    await expect(loadReaderConfig(directory)).rejects.toThrow(/must be a directory/);
    await writeFile(
      join(directory, "tack.reader.yaml"),
      stringify({ ...valid, components: { module: "working" } }),
    );
    await expect(loadReaderConfig(directory)).rejects.toThrow(/must be a file/);
    await symlink(outside, join(directory, "outside"));
    await writeFile(
      join(directory, "tack.reader.yaml"),
      stringify({
        ...valid,
        content: [{ root: "outside", include: ["**/*.mdx"], exclude: [] }],
      }),
    );
    await expect(loadReaderConfig(directory)).rejects.toThrow(/resolves outside/);
  });

  it("resolves explicitly declared in-worktree symlinks to the physical source location", async () => {
    const directory = await fixture();
    await symlink(join(directory, "working"), join(directory, "linked"));
    await writeFile(
      join(directory, "tack.reader.yaml"),
      stringify({
        ...valid,
        content: [{ root: "linked", include: ["**/*.mdx"], exclude: [] }],
      }),
    );
    expect((await loadReaderConfig(directory)).content[0]?.root).toBe(join(directory, "working"));
  });
});
