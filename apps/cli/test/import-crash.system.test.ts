/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests read JSON envelopes whose shape each test asserts. */
import { skillText } from "./support/source-tree.ts";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeSystemWorld, treeSnapshot, type SystemWorld } from "./support/import-system.ts";

/** A real SIGKILL at each step of the safe write order, then the next command converges. */

const commit = {
  files: {
    "skills/pdf/SKILL.md": skillText("pdf"),
    "skills/pdf/scripts/fill.py": { content: "print('x')\n", executable: true },
    "skills/docx/SKILL.md": skillText("docx"),
  },
} as const;

const staging = ".tack-import-staging";
const addPdf = [
  "import",
  "add",
  "github:acme/skills",
  "--skill",
  "pdf",
  "--into",
  "personal-brain",
  "--apply",
];
const addDocx = [
  "import",
  "add",
  "github:acme/skills",
  "--skill",
  "docx",
  "--into",
  "personal-brain",
  "--apply",
];

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const readStateBytes = (world: SystemWorld) => readFile(join(world.state, "state.json"), "utf8");

const importList = async (world: SystemWorld) =>
  (await world.json(["import"])).envelope.result as {
    readonly imports: ReadonlyArray<{ readonly reference: string }>;
    readonly problems: ReadonlyArray<{ readonly code: string; readonly source: string }>;
  };

/** Every top-level key of a tack.yaml must still parse, whatever the step. */
const parsedYaml = async (world: SystemWorld) =>
  Bun.YAML.parse(await readFile(join(world.brain, "tack.yaml"), "utf8")) as Record<string, unknown>;

const newWorld = () => makeSystemWorld({ commits: [commit] });

describe("a killed import add", () => {
  for (const step of ["intent", "staged", "moved", "tack-yaml"] as const) {
    const moved = step === "moved" || step === "tack-yaml";
    it(`leaves a whole tack.yaml and a recoverable staging folder after a kill at ${step}`, async () => {
      const world = await newWorld();
      const stateBefore = await readStateBytes(world);
      const yamlBefore = await readFile(join(world.brain, "tack.yaml"), "utf8");

      const crashed = await world.run(addPdf, { env: { TACK_IMPORT_CRASH_AT: step } });
      expect(crashed.code).not.toBe(0);
      expect(crashed.stdout).toBe("");

      // State is never written by import, so a kill cannot change it.
      expect(await readStateBytes(world)).toBe(stateBefore);
      expect(await exists(join(world.brain, staging))).toBe(true);
      // The folder is either absent (before the move) or complete (after it).
      expect(await exists(join(world.brain, "skills", "pdf", "SKILL.md"))).toBe(moved);
      const yaml = await parsedYaml(world);
      expect(yaml["version"]).toBe(1);
      const yamlNow = await readFile(join(world.brain, "tack.yaml"), "utf8");
      // tack.yaml is the old file until the rename, and the new file after it, never partial.
      if (step === "tack-yaml") {
        expect(yamlNow.startsWith(yamlBefore)).toBe(true);
        expect(yamlNow).toContain("path: skills/pdf");
      } else expect(yamlNow).toBe(yamlBefore);

      // The leftover is reported by the offline listing, with the source it belongs to.
      const listed = await importList(world);
      expect(listed.problems).toMatchObject([
        { code: "staging-left-over", source: "personal-brain" },
      ]);

      // The next import for the source settles it first, then does its own work.
      const next = await world.json(addDocx);
      expect(next.envelope).toMatchObject({ classification: "success" });
      expect(next.envelope.applied.recovered).toEqual([
        moved
          ? "Finished the interrupted import of skills/pdf."
          : "Rolled back the interrupted import of skills/pdf.",
      ]);
      expect(await exists(join(world.brain, staging))).toBe(false);
      expect((await importList(world)).problems).toEqual([]);
      const references = (await importList(world)).imports.map((item) => item.reference);
      expect(references).toEqual(
        moved ? ["personal-brain:docx", "personal-brain:pdf"] : ["personal-brain:docx"],
      );
      // A rolled-back skill was never half-written, and a finished one is whole.
      expect(await exists(join(world.brain, "skills", "pdf", "SKILL.md"))).toBe(moved);
      expect(await readStateBytes(world)).toBe(stateBefore);

      // A clean repeat of the interrupted command now works (or says it is already imported).
      const again = await world.json(addPdf);
      if (moved) {
        expect(again.envelope.classification).toBe("invalid-configuration");
        expect(again.envelope.diagnostics[0].message).toContain("already imported");
      } else {
        expect(again.envelope.classification).toBe("success");
        expect((await importList(world)).imports.map((item) => item.reference)).toEqual([
          "personal-brain:docx",
          "personal-brain:pdf",
        ]);
      }
      expect(await exists(join(world.brain, staging))).toBe(false);
      const status = await world.json(["import"]);
      expect(
        status.envelope.result.imports.every(
          (item: { local: { state: string } }) => item.local.state === "unchanged",
        ),
      ).toBe(true);
    }, 60_000);
  }

  it("does not change the destination tree beyond the imported folder and tack.yaml after recovery", async () => {
    const world = await newWorld();
    await world.run(addPdf, { env: { TACK_IMPORT_CRASH_AT: "staged" } });
    await world.run(addDocx);
    const tree = Object.keys(await treeSnapshot(world.brain)).sort();
    expect(tree).toEqual([
      "skills/",
      "skills/docx/",
      "skills/docx/SKILL.md",
      "skills/mine/",
      "skills/mine/SKILL.md",
      "tack.yaml",
    ]);
  }, 60_000);
});

describe("a killed import remove", () => {
  const imported = async () => {
    const world = await newWorld();
    const added = await world.json(addPdf);
    expect(added.envelope.classification).toBe("success");
    return world;
  };

  for (const step of ["intent", "moved", "tack-yaml"] as const) {
    // Before the move nothing changed, so the next command rolls the removal back; after it the
    // folder is in staging, so the next command finishes the removal.
    const finished = step !== "intent";
    it(`${finished ? "finishes" : "rolls back"} the removal after a kill at ${step}`, async () => {
      const world = await imported();
      const stateBefore = await readStateBytes(world);
      const crashed = await world.run(["import", "remove", "personal-brain:pdf", "--apply"], {
        env: { TACK_IMPORT_CRASH_AT: step },
      });
      expect(crashed.code).not.toBe(0);
      expect(await readStateBytes(world)).toBe(stateBefore);
      expect(await exists(join(world.brain, staging))).toBe(true);
      expect(await exists(join(world.brain, "skills", "pdf"))).toBe(!finished);
      await parsedYaml(world);
      expect((await importList(world)).problems).toMatchObject([{ code: "staging-left-over" }]);

      // The next import command settles it. Another removal of the same skill converges.
      const next = await world.json(["import", "remove", "personal-brain:pdf", "--apply"]);
      expect(await exists(join(world.brain, staging))).toBe(false);
      if (finished) {
        expect(next.envelope.classification).toBe("success");
        expect(next.envelope.applied.recovered).toEqual([
          "Finished the interrupted removal of skills/pdf.",
        ]);
      } else {
        expect(next.envelope.classification).toBe("success");
        expect(next.envelope.applied.recovered).toEqual([
          "Rolled back the interrupted removal of skills/pdf.",
        ]);
      }
      // Either way the folder and the record now agree, and a second clean run works.
      expect(await exists(join(world.brain, "skills", "pdf"))).toBe(false);
      expect((await importList(world)).imports).toEqual([]);
      expect((await importList(world)).problems).toEqual([]);
      expect(await readStateBytes(world)).toBe(stateBefore);
      const second = await world.json(addPdf);
      expect(second.envelope.classification).toBe("success");
      expect((await importList(world)).imports.map((item) => item.reference)).toEqual([
        "personal-brain:pdf",
      ]);
    }, 60_000);
  }
});
