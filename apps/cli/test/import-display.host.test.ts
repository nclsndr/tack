import { fakeGit } from "./support/fake-git.ts";
import { skillText } from "./support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { renderHuman } from "../src/cli/host/human/render.ts";
import { makeStyle } from "../src/cli/host/human/style.ts";
import { CatalogReportSchema } from "../src/domain/sources/catalog-report.ts";
import { recordFilesOf, type SkillFile } from "../src/features/imports/import-files.ts";
import type { ImportRecord } from "../src/domain/imports/import-record.ts";
import { stagingPathOf, writeImports } from "../src/features/imports/import-write.ts";
import { runHost } from "./support/host-runner.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

const decodeCatalog = Schema.decodeUnknownSync(CatalogReportSchema);
const encoder = new TextEncoder();
const filesOf = (name: string): ReadonlyArray<SkillFile> => [
  { path: "SKILL.md", bytes: encoder.encode(skillText(name)), executable: false },
  { path: "notes.md", bytes: encoder.encode("notes\n"), executable: false },
];
const recordOf = (name: string): ImportRecord => {
  const { files, digest } = recordFilesOf(filesOf(name));
  return {
    path: `skills/${name}`,
    location: "github:acme/skills",
    transport: "https",
    "ref-kind": "tag",
    ref: "v1.2.0",
    revision: "c".repeat(40),
    "upstream-path": `skills/${name}`,
    "upstream-tree": "d".repeat(40),
    "imported-at": "2026-11-11T12:40:00Z",
    digest,
    files,
  };
};

/** A registered source holding the imported skills pdf and docx, and one registered project. */
const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-import-display-host-" }),
  );
  const stateDirectory = path.join(root, "state");
  const anchor = path.join(root, "anchor");
  const projectRoot = path.join(root, "project");
  const source = path.join(root, "personal-brain");
  yield* Effect.forEach([anchor, projectRoot, path.join(source, "skills", "mine")], (directory) =>
    fileSystem.makeDirectory(directory, { recursive: true }),
  );
  yield* fileSystem.writeFileString(
    path.join(source, "tack.yaml"),
    "version: 1\nname: personal-brain\nskills:\n  - path: skills\n",
  );
  yield* fileSystem.writeFileString(
    path.join(source, "skills", "mine", "SKILL.md"),
    skillText("mine"),
  );
  yield* writeImports(
    source,
    ["pdf", "docx"].map((name) => ({
      name,
      path: `skills/${name}`,
      files: filesOf(name),
      record: recordOf(name),
      newFolders: [],
    })),
  );
  const git = fakeGit(anchor, [{ path: projectRoot }]);
  const tack = (arguments_: ReadonlyArray<string>) =>
    runHost({ args: ["--json", "--state-dir", stateDirectory, ...arguments_], git }).pipe(
      Effect.map(({ stdout }) => decodeEnvelope(stdout)),
    );
  yield* tack(["state", "init"]);
  yield* tack(["source", "add", source, "--apply"]);
  yield* tack(["project", "add", "workspace", "--repository-cwd", projectRoot]);
  return { fileSystem, path, source, tack };
});

it.layer(LiveTestLayer)("import provenance display", (test) => {
  test.effect("source counts imported skills, and catalog tags them with details on request", () =>
    Effect.gen(function* () {
      const { fileSystem, path, source, tack } = yield* fixture;
      yield* fileSystem.writeFileString(path.join(source, "skills/pdf/notes.md"), "edited\n");

      const sources = yield* tack(["source"]);
      expect(sources.result).toMatchObject({
        sources: [
          {
            imports: {
              total: 2,
              locallyChanged: 1,
              missing: 0,
              invalid: false,
              stagingLeftOver: false,
            },
          },
        ],
      });

      const concise = yield* tack(["catalog"]);
      const resources = decodeCatalog(concise.result).resources;
      const named = (
        list: ReadonlyArray<{ readonly address: { readonly name: string } }>,
        name: string,
      ) => list.find((resource) => resource.address.name === name);
      expect(named(resources, "pdf")).toMatchObject({ imported: true });
      expect(named(resources, "pdf")).not.toHaveProperty("import");
      expect(named(resources, "mine")).not.toHaveProperty("imported");

      const detailed = yield* tack(["catalog", "--details"]);
      const detailedResources = decodeCatalog(detailed.result).resources;
      expect(named(detailedResources, "pdf")).toMatchObject({
        imported: true,
        import: {
          path: "skills/pdf",
          location: "github:acme/skills",
          ref: { kind: "tag", request: "v1.2.0", tracking: false },
          revision: "c".repeat(40),
          local: "changed",
        },
      });
      expect(named(detailedResources, "docx")).toMatchObject({ import: { local: "unchanged" } });
    }),
  );

  test.effect("status lists local changes as information and problems as partial causes", () =>
    Effect.gen(function* () {
      const { fileSystem, path, source, tack } = yield* fixture;
      yield* fileSystem.writeFileString(path.join(source, "skills/pdf/notes.md"), "edited\n");
      yield* tack(["adapter", "enable", "claude"]);
      yield* tack(["sync", "--project", "workspace", "--apply"]);

      const changed = yield* tack(["status", "--project", "workspace"]);
      expect(changed.result).toMatchObject({
        imports: { total: 2, locallyChanged: 1, problems: [] },
      });
      expect(changed.diagnostics.map(({ code }) => code)).not.toContain("import-folder-missing");

      yield* fileSystem.remove(path.join(source, "skills/docx"), { recursive: true });
      yield* fileSystem.makeDirectory(stagingPathOf(source), { recursive: true });
      const missing = yield* tack(["status", "--project", "workspace"]);
      expect(missing.classification).toBe("partial");
      expect(missing.result).toMatchObject({
        imports: {
          total: 2,
          problems: [
            {
              code: "import-folder-missing",
              reference: "personal-brain:docx",
              path: "skills/docx",
            },
            { code: "import-staging-left-over", source: "personal-brain" },
          ],
        },
      });
      expect(missing.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "import-folder-missing",
          details: { subject: expect.objectContaining({ reference: "personal-brain:docx" }) },
          severity: "warning",
        }),
      );
    }),
  );

  test.effect(
    "the human views show the counts, the imported tag, the details and the next steps",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, source, tack } = yield* fixture;
        const style = makeStyle({ color: false, width: 120, homeDirectory: "/home/operator" });
        yield* fileSystem.writeFileString(path.join(source, "skills/pdf/notes.md"), "edited\n");
        yield* fileSystem.remove(path.join(source, "skills/docx"), { recursive: true });

        const sources = renderHuman(yield* tack(["source"]), style);
        expect(sources).toContain("imports");
        expect(sources).toContain("2 imported skills · 1 locally changed");
        expect(sources).toContain("1 folder missing");

        const catalog = renderHuman(yield* tack(["catalog"]), style);
        expect(catalog).toMatch(/pdf\s+personal-brain · imported/);
        expect(catalog).not.toContain("imported from");
        const detailed = renderHuman(yield* tack(["catalog", "--details"]), style);
        expect(detailed).toContain(
          "pdf imported from github:acme/skills · pinned v1.2.0 · cccccccccccc · locally changed",
        );

        const status = renderHuman(yield* tack(["status", "--project", "workspace"]), style);
        expect(status).toContain("Imports");
        expect(status).toContain("2 imported skills, 1 locally changed, 1 problem");
        expect(status).toContain("tack import remove personal-brain:docx");
      }),
  );
});
