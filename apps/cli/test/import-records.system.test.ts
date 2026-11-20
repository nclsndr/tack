/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests read JSON envelopes whose shape each test asserts. */
import { skillText } from "./support/source-tree.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeSystemWorld } from "./support/import-system.ts";

/**
 * A `tack.yaml` exactly as import phase 1 (#83, merged as f006a73) wrote it: the writer has not
 * changed since, so this is also what every release before the provider prefix produced.
 */
const written = await readFile(
  join(import.meta.dirname, "fixtures/import/phase-1-written.tack.yaml"),
  "utf8",
);
const files = { "skills/pdf/SKILL.md": skillText("pdf") };
const commit = { files: { "skills/pdf/SKILL.md": skillText("pdf") } } as const;

describe("records written before the provider prefix", () => {
  it("list, report local change, check and remove with no edit", async () => {
    const world = await makeSystemWorld({ declaration: written, files, commits: [commit] });
    const listed = await world.json(["import"]);
    expect(listed.code).toBe(0);
    expect(listed.envelope.result.imports).toMatchObject([
      {
        name: "pdf",
        location: "github:anthropics/skills",
        transport: "https",
        local: { state: "unchanged" },
      },
    ]);
    for (const args of [["status", "--all"], ["doctor"]]) {
      const run = await world.json(args);
      const codes = run.envelope.diagnostics.map((entry: { code: string }) => entry.code);
      expect(
        codes.filter((code: string) => code.startsWith("import")),
        args.join(" "),
      ).toEqual([]);
    }
    const preview = await world.json(["import", "remove", "personal-brain:pdf"]);
    expect(preview.envelope.plan).toMatchObject({
      reference: "personal-brain:pdf",
      folderPresent: true,
    });
    const removed = await world.json(["import", "remove", "personal-brain:pdf", "--apply"]);
    expect(removed.code).toBe(0);
    expect(await readFile(join(world.brain, "tack.yaml"), "utf8")).not.toContain("imports:");
  }, 60_000);

  it("report a hand edit as a local change", async () => {
    const world = await makeSystemWorld({ declaration: written, files, commits: [commit] });
    await Bun.write(join(world.brain, "skills/pdf/SKILL.md"), "edited\n");
    const listed = await world.json(["import"]);
    expect(listed.envelope.result.imports[0].local).toMatchObject({
      state: "changed",
      changed: ["SKILL.md"],
    });
  }, 60_000);
});

describe("a record from a provider this release lacks", () => {
  const newer = written.replace("github:anthropics/skills", "forge:acme/repo");

  it("keeps import, import remove, status and doctor working on its source", async () => {
    expect(newer).toContain("location: forge:acme/repo");
    const world = await makeSystemWorld({ declaration: newer, files, commits: [commit] });
    const listed = await world.json(["import"]);
    expect(listed.code).toBe(0);
    expect(listed.envelope.result.imports).toMatchObject([
      { name: "pdf", location: "forge:acme/repo", local: { state: "unchanged" } },
    ]);
    for (const args of [["status", "--all"], ["doctor"]]) {
      const run = await world.json(args);
      expect(run.envelope.diagnostics.map((entry: { code: string }) => entry.code)).not.toContain(
        "imports-invalid",
      );
    }
    const removed = await world.json(["import", "remove", "personal-brain:pdf", "--apply"]);
    expect(removed.code).toBe(0);
  }, 60_000);

  it("is another location to import add: the verdict names the record", async () => {
    const world = await makeSystemWorld({ declaration: newer, files, commits: [commit] });
    const preview = await world.json([
      "import",
      "add",
      "github:acme/skills",
      "--skill",
      "pdf",
      "--into",
      "personal-brain",
    ]);
    expect(preview.envelope.diagnostics[0]).toMatchObject({
      code: "import-candidate-not-importable",
    });
    const message = preview.envelope.diagnostics[0].message as string;
    expect(message).toContain("import-imported-elsewhere");
    expect(message).toContain("forge:acme/repo");
  }, 60_000);
});
