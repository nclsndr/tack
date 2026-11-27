import { skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { initializeState, readState, type StateOptions } from "../../services/state-store.ts";
import { catalogReport } from "../../domain/sources/catalog-report.ts";
import { resolveCatalog } from "../sources/catalog.ts";
import { inspectSources, registerSource } from "../sources/source.ts";
import { observeImportsDisplay } from "./import-display.ts";
import { recordFilesOf, type SkillFile } from "./import-files.ts";
import type { ImportRecord } from "../../domain/imports/import-record.ts";
import { writeImports } from "./import-write.ts";
import { stagingPathOf } from "./import-write.ts";
import { stateOptionsAt } from "../../../test/support/state-fixture.ts";

const text = new TextEncoder();
const skillFiles = (name: string): ReadonlyArray<SkillFile> => [
  { path: "SKILL.md", bytes: text.encode(skillText(name)), executable: false },
  { path: "notes/a.md", bytes: text.encode("a\n"), executable: false },
];
const record = (path: string, files: ReadonlyArray<SkillFile>): ImportRecord => {
  const { files: entries, digest } = recordFilesOf(files);
  return {
    path,
    location: "github:acme/skills",
    transport: "https",
    "ref-kind": "branch",
    ref: "main",
    revision: "a".repeat(40),
    "upstream-path": `skills/${path.split("/").at(-1) ?? ""}`,
    "upstream-tree": "b".repeat(40),
    "imported-at": "2026-11-11T12:40:00Z",
    digest,
    files: entries,
  };
};

type Sources = Effect.Success<ReturnType<typeof inspectSources>>;

/** A registered source declaring `skills`, with one authored skill and the given imported ones. */
export const withImportedSource = <A, E, R>(
  imported: ReadonlyArray<string>,
  use: (context: {
    readonly root: string;
    readonly options: StateOptions;
    readonly inspections: Sources;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-display-" }));
    const options = stateOptionsAt(path.join(base, "state"), base);
    yield* initializeState(options);
    const root = path.join(base, "personal-brain");
    yield* fs.makeDirectory(path.join(root, "skills", "mine"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "tack.yaml"),
      "version: 1\nname: personal-brain\nskills: [{ path: skills }]\n",
    );
    yield* fs.writeFileString(path.join(root, "skills", "mine", "SKILL.md"), skillText("mine"));
    yield* registerSource(options, { sourcePath: root });
    yield* writeImports(
      root,
      imported.map((name) => ({
        name,
        path: `skills/${name}`,
        files: skillFiles(name),
        record: record(`skills/${name}`, skillFiles(name)),
        newFolders: [],
      })),
    );
    const inspections = yield* inspectSources(yield* readState(options));
    return yield* use({ root, options, inspections });
  }).pipe(Effect.scoped);

it.layer(LiveTestLayer)("import display", (test) => {
  test.effect("counts an unchanged import, tags it in the catalog and reports details", () =>
    withImportedSource(["pdf"], ({ inspections }) =>
      Effect.gen(function* () {
        const catalog = yield* resolveCatalog(inspections);
        const display = yield* observeImportsDisplay(inspections, catalog);
        const [source] = [...display.bySource.values()];
        expect(source).toEqual({
          total: 1,
          locallyChanged: 0,
          missing: 0,
          uncataloged: 0,
          invalid: false,
          stagingLeftOver: false,
        });
        expect(display.problems).toEqual([]);
        const concise = catalogReport(catalog, { imported: display.byDirectory });
        const pdf = concise.resources.find((resource) => resource.address.name === "pdf");
        expect(pdf).toMatchObject({ imported: true });
        expect(pdf).not.toHaveProperty("import");
        const mine = concise.resources.find((resource) => resource.address.name === "mine");
        expect(mine).not.toHaveProperty("imported");
        const detailed = catalogReport(catalog, { details: true, imported: display.byDirectory });
        expect(
          detailed.resources.find((resource) => resource.address.name === "pdf"),
        ).toMatchObject({
          imported: true,
          import: {
            path: "skills/pdf",
            location: "github:acme/skills",
            ref: { kind: "branch", request: "main", tracking: true },
            revision: "a".repeat(40),
            local: "unchanged",
          },
        });
      }),
    ),
  );

  test.effect("counts a local change as information and a missing folder as a problem", () =>
    withImportedSource(["pdf", "docx"], ({ root, inspections }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(path.join(root, "skills/pdf/notes/a.md"), "edited\n");
        yield* fs.remove(path.join(root, "skills/docx"), { recursive: true });
        const catalog = yield* resolveCatalog(inspections);
        const display = yield* observeImportsDisplay(inspections, catalog);
        const [source] = [...display.bySource.values()];
        expect(source).toMatchObject({ total: 2, locallyChanged: 1, missing: 1 });
        const states = Object.fromEntries(
          display.imports.map((summary) => [summary.name, summary.local.state]),
        );
        expect(states).toEqual({ docx: "missing", pdf: "changed" });
      }),
    ),
  );

  test.effect("reports an unreadable imports section and a leftover staging folder", () =>
    withImportedSource(["pdf"], ({ root, inspections }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(stagingPathOf(root), { recursive: true });
        const yaml = yield* fs.readFileString(path.join(root, "tack.yaml"));
        yield* fs.writeFileString(
          path.join(root, "tack.yaml"),
          yaml.replace("imports:", "imports: []\nold:"),
        );
        const catalog = yield* resolveCatalog(inspections);
        const display = yield* observeImportsDisplay(inspections, catalog);
        const [source] = [...display.bySource.values()];
        expect(source).toMatchObject({ total: 0, invalid: true, stagingLeftOver: true });
        expect(display.problems.map((problem) => problem.code).sort()).toEqual([
          "imports-invalid",
          "staging-left-over",
        ]);
      }),
    ),
  );
});
