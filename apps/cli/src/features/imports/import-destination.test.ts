import { bareSkillText, declare } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { initializeState, readState, type StateOptions } from "../../services/state-store.ts";
import { inspectSources, registerSource } from "../sources/source.ts";
import {
  destinationChoices,
  resolveDestination,
  resolveDestinationSource,
  sourceDisplayName,
} from "./import-destination.ts";
import { declarationSelects } from "./import-verdict.ts";
import { stateOptionsAt } from "../../../test/support/state-fixture.ts";

/** Registers one source built from the declaration and files, and gives its inspections. */
const withDestination = <A, E, R>(
  declaration: string,
  files: Readonly<Record<string, string>>,
  use: (context: {
    readonly root: string;
    readonly options: StateOptions;
    readonly inspections: Effect.Success<ReturnType<typeof inspectSources>>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "tack-import-destination-" }),
    );
    const options = stateOptionsAt(path.join(base, "state"), base);
    yield* initializeState(options);
    const root = path.join(base, "personal-brain");
    yield* fs.makeDirectory(root, { recursive: true });
    yield* fs.writeFileString(path.join(root, "tack.yaml"), declaration);
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, content);
    }
    yield* registerSource(options, { sourcePath: root });
    const inspections = yield* inspectSources(yield* readState(options));
    return yield* use({ root, options, inspections });
  });

it.layer(LiveTestLayer)("import destination", (test) => {
  test.effect("a source with one declared skills folder is the default destination", () =>
    withDestination(
      declare("personal-brain", "skills: [{ path: skills }]"),
      { "skills/a/SKILL.md": bareSkillText("a") },
      ({ inspections }) =>
        Effect.gen(function* () {
          const source = yield* resolveDestinationSource(inspections, "personal-brain");
          expect(sourceDisplayName(source)).toBe("personal-brain");
          const destination = yield* resolveDestination(source, undefined);
          expect(destination).toMatchObject({
            name: "personal-brain",
            folder: "skills",
            missingFolders: [],
          });
          expect(yield* destinationChoices(inspections)).toMatchObject([
            { name: "personal-brain", folders: ["skills"] },
          ]);
        }),
    ),
  );

  test.effect("a skills entry at . receives skills anywhere below the source folder", () =>
    withDestination(
      declare("personal-brain", "skills: [{ path: . }]"),
      { "a/SKILL.md": bareSkillText("a") },
      (context) =>
        Effect.gen(function* () {
          const source = yield* resolveDestinationSource(context.inspections, "personal-brain");
          expect(yield* resolveDestination(source, undefined)).toMatchObject({
            folder: ".",
            covering: { declaredPath: ".", resolved: context.root },
            missingFolders: [],
          });
          expect(yield* destinationChoices(context.inspections)).toMatchObject([
            { name: "personal-brain", folders: ["."] },
          ]);
          expect(yield* resolveDestination(source, "team/review")).toMatchObject({
            folder: "team/review",
            missingFolders: ["team", "team/review"],
          });
          const refused = yield* resolveDestination(source, "team/_drafts").pipe(Effect.flip);
          expect(refused).toMatchObject({
            code: "import-destination-invalid",
            message:
              'team/_drafts holds _drafts, a name the skills entry "." passes over, as it passes over every dot, underscore and node_modules name, so skills there are not in the catalog. Choose another folder.',
          });
        }),
    ),
  );

  test.effect("a commands entry at . declares no skills folder to import into", () =>
    withDestination(
      declare("personal-brain", "commands: [{ path: . }]"),
      { "ship.md": "# Ship" },
      ({ inspections }) =>
        Effect.gen(function* () {
          expect(yield* destinationChoices(inspections)).toMatchObject([
            { name: "personal-brain", folders: [] },
          ]);
        }),
    ),
  );

  test.effect(
    "a source is found by registration ID, and an unknown or built-in name is refused",
    () =>
      withDestination(
        declare("personal-brain", "skills: [{ path: skills }]"),
        { "skills/a/SKILL.md": bareSkillText("a") },
        ({ inspections }) =>
          Effect.gen(function* () {
            const byLabel = yield* resolveDestinationSource(inspections, "personal-brain");
            const byId = yield* resolveDestinationSource(inspections, byLabel.registration.id);
            expect(byId.registration.id).toBe(byLabel.registration.id);
            const unknown = yield* resolveDestinationSource(inspections, "nowhere").pipe(
              Effect.flip,
            );
            expect(unknown).toMatchObject({ code: "import-destination-invalid" });
            expect(unknown.message).toContain("Registered sources: personal-brain");
            const builtin = yield* resolveDestinationSource(inspections, "tack").pipe(Effect.flip);
            expect(builtin.message).toContain("built-in");
          }),
      ),
  );

  test.effect("several declared skills folders are refused and listed as choices", () =>
    withDestination(
      declare("personal-brain", "skills:", "  - path: skills", "  - path: vendor/skills"),
      { "skills/a/SKILL.md": bareSkillText("a"), "vendor/skills/b/SKILL.md": bareSkillText("b") },
      ({ inspections }) =>
        Effect.gen(function* () {
          const source = yield* resolveDestinationSource(inspections, "personal-brain");
          const refused = yield* resolveDestination(source, undefined).pipe(Effect.flip);
          expect(refused.message).toContain(
            "--into personal-brain:skills or --into personal-brain:vendor/skills",
          );
          const chosen = yield* resolveDestination(source, "vendor/skills");
          expect(chosen).toMatchObject({ folder: "vendor/skills", missingFolders: [] });
          const created = yield* resolveDestination(source, "vendor/skills/anthropic/");
          expect(created).toMatchObject({
            folder: "vendor/skills/anthropic",
            missingFolders: ["vendor/skills/anthropic"],
          });
          const deeper = yield* resolveDestination(source, "vendor/skills/anthropic/pdf");
          expect(deeper.missingFolders).toEqual([
            "vendor/skills/anthropic",
            "vendor/skills/anthropic/pdf",
          ]);
        }),
    ),
  );

  test.effect("a source with no declared skills folder shows the entry to add by hand", () =>
    withDestination(
      declare("personal-brain", "docs: [{ path: docs }]"),
      { "docs/readme.md": "# Docs" },
      ({ inspections }) =>
        Effect.gen(function* () {
          const source = yield* resolveDestinationSource(inspections, "personal-brain");
          const refused = yield* resolveDestination(source, undefined).pipe(Effect.flip);
          expect(refused.message).toContain("skills: [{ path: skills }]");
          expect(refused.message).toContain("never edits a declaration");
          const outside = yield* resolveDestination(source, "tools").pipe(Effect.flip);
          expect(outside.message).toContain("skills: [{ path: tools }]");
          expect(yield* destinationChoices(inspections)).toMatchObject([{ folders: [] }]);
        }),
    ),
  );

  test.effect("a single-skill entry does not count as a declared folder", () =>
    withDestination(
      declare("personal-brain", "skills: [{ path: skills/only }]"),
      { "skills/only/SKILL.md": bareSkillText("only") },
      ({ inspections }) =>
        Effect.gen(function* () {
          const source = yield* resolveDestinationSource(inspections, "personal-brain");
          const refused = yield* resolveDestination(source, undefined).pipe(Effect.flip);
          expect(refused.message).toContain("declares no skills folder");
        }),
    ),
  );

  test.effect("a folder outside the declarations is refused with the choices", () =>
    withDestination(
      declare("personal-brain", "skills: [{ path: skills }]"),
      { "skills/a/SKILL.md": bareSkillText("a"), "other/x.txt": "x" },
      ({ inspections }) =>
        Effect.gen(function* () {
          const source = yield* resolveDestinationSource(inspections, "personal-brain");
          const outside = yield* resolveDestination(source, "other").pipe(Effect.flip);
          expect(outside.message).toContain("outside every skills folder");
          expect(outside.message).toContain("--into personal-brain:skills");
          const malformed = yield* resolveDestination(source, "../up").pipe(Effect.flip);
          expect(malformed.message).toContain("is not valid");
        }),
    ),
  );

  test.effect("a folder excluded by the declaration patterns, or inside a skill, is refused", () =>
    withDestination(
      declare("personal-brain", "skills:", "  - path: skills", '    exclude: ["**/_*/**"]'),
      {
        "skills/a/SKILL.md": bareSkillText("a"),
        "skills/_archive/old/SKILL.md": bareSkillText("old"),
        "skills/group/x.txt": "x",
      },
      ({ inspections }) =>
        Effect.gen(function* () {
          const source = yield* resolveDestinationSource(inspections, "personal-brain");
          const excluded = yield* resolveDestination(source, "skills/_archive").pipe(Effect.flip);
          expect(excluded.message).toContain("excluded by the exclude patterns");
          const inside = yield* resolveDestination(source, "skills/a").pipe(Effect.flip);
          expect(inside.message).toContain("a skill folder is a leaf");
          const below = yield* resolveDestination(source, "skills/a/inner").pipe(Effect.flip);
          expect(below.message).toContain("skills/a is a skill folder");
          const group = yield* resolveDestination(source, "skills/group");
          expect(group.missingFolders).toEqual([]);
        }),
    ),
  );

  test.effect("a path that is a file, or leaves the source through a link, is refused", () =>
    withDestination(
      declare("personal-brain", "skills: [{ path: skills }]"),
      { "skills/a/SKILL.md": bareSkillText("a"), "skills/file.txt": "x" },
      ({ inspections, root }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const outside = path.join(path.dirname(root), "outside");
          yield* fs.makeDirectory(outside, { recursive: true });
          yield* fs.symlink(outside, path.join(root, "skills", "escape"));
          const source = yield* resolveDestinationSource(inspections, "personal-brain");
          const file = yield* resolveDestination(source, "skills/file.txt").pipe(Effect.flip);
          expect(file.message).toContain("is not a folder");
          const escape = yield* resolveDestination(source, "skills/escape").pipe(Effect.flip);
          expect(escape.message).toContain("outside the source");
        }),
    ),
  );

  test.effect("a label two registrations share is refused, and each shows by registration ID", () =>
    withDestination(
      declare("personal-brain", "skills: [{ path: skills }]"),
      { "skills/a/SKILL.md": bareSkillText("a") },
      ({ root, options }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const twin = path.join(path.dirname(root), "twin", "personal-brain");
          yield* fs.makeDirectory(path.join(twin, "skills"), { recursive: true });
          yield* fs.writeFileString(
            path.join(twin, "tack.yaml"),
            declare("personal-brain", "skills: [{ path: skills }]"),
          );
          yield* registerSource(options, { sourcePath: twin });
          const inspections = yield* inspectSources(yield* readState(options));
          const ids = inspections.map((inspection) => inspection.registration.id);
          expect(inspections.map(sourceDisplayName).sort()).toEqual([...ids].sort());
          const error = yield* resolveDestinationSource(inspections, "personal-brain").pipe(
            Effect.flip,
          );
          expect(error).toMatchObject({ code: "import-destination-invalid" });
          expect(error.message).toContain("belongs to several registrations");
          expect(error.details).toEqual({ candidates: ids });
        }),
    ),
  );

  test.effect("an unhealthy source is refused as a destination with its issue", () =>
    withDestination(
      declare("personal-brain", "skills: [{ path: skills }]"),
      { "skills/a/SKILL.md": bareSkillText("a") },
      ({ root, options }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${root}/tack.yaml`, "version: 99\n");
          const inspections = yield* inspectSources(yield* readState(options));
          const id = inspections[0]?.registration.id ?? "";
          const error = yield* resolveDestinationSource(inspections, id).pipe(Effect.flip);
          expect(error).toMatchObject({ code: "import-destination-invalid" });
          expect(error.message).toContain(`The source ${id} is not healthy:`);
          expect(error.message).toContain("`tack source` shows its health");
        }),
    ),
  );

  test.effect("without a writable source, the refusal says how to register one", () =>
    withDestination(
      declare("personal-brain", "skills: [{ path: skills }]"),
      {},
      ({ root, options }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${root}/tack.yaml`, "version: 99\n");
          const inspections = yield* inspectSources(yield* readState(options));
          const error = yield* resolveDestinationSource(inspections, "nope").pipe(Effect.flip);
          expect(error.message).toContain(
            "No source is registered that can receive imports. Register one with `tack source add <path>`.",
          );
        }),
    ),
  );

  test.effect("a group folder's new skill is checked against the exclude patterns alone", () =>
    withDestination(
      declare("personal-brain", "skills:", "  - path: skills", '    exclude: ["**/pdf"]'),
      { "skills/a/SKILL.md": bareSkillText("a") },
      ({ inspections }) =>
        Effect.gen(function* () {
          const source = yield* resolveDestinationSource(inspections, "personal-brain");
          const group = yield* resolveDestination(source, "skills/team");
          expect(declarationSelects(group, "docx")).toBeUndefined();
          expect(declarationSelects(group, "pdf")).toBe(
            'The skills entry "skills" does not select skills/team/pdf: exclude ["**/pdf"]. Choose another folder, or change the patterns by hand.',
          );
        }),
    ),
  );
});
