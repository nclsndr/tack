import { declare, skillText } from "../../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem } from "effect";
import { vi } from "vitest";
import { LiveTestLayer } from "../../../../test/support/live-test-layer.ts";
import { withImportWorld, type ImportWorld } from "../../../../test/support/import-world.ts";
import { stagingPathOf } from "../../../features/imports/import-write.ts";
import { crashAtVariable } from "../../../services/installation.ts";
import { importRoutes } from "./imports.ts";
import { routeOutcome } from "./route.test-support.ts";

const commit = {
  files: {
    "skills/pdf/SKILL.md": skillText("pdf"),
    "skills/docx/SKILL.md": skillText("docx"),
  },
} as const;
const declaration = declare("personal-brain", "skills: [{ path: skills }]");
const files = { "skills/mine/SKILL.md": skillText("mine") };

const add = (
  world: ImportWorld,
  request: Partial<{ into: string; skills: ReadonlyArray<string>; apply: boolean }> = {},
) =>
  routeOutcome(
    importRoutes["import-add"].run(
      {
        _tag: "import-add",
        location: "github:acme/skills",
        skills: [],
        all: false,
        fullDepth: false,
        apply: false,
        ...request,
      },
      world.options,
    ),
  );

const remove = (world: ImportWorld, apply: boolean) =>
  routeOutcome(
    importRoutes["import-remove"].run(
      { _tag: "import-remove", reference: "personal-brain:pdf", force: false, apply },
      world.options,
    ),
  );

const codes = (outcome: { readonly diagnostics: ReadonlyArray<{ readonly code: string }> }) =>
  outcome.diagnostics.map(({ code }) => code);

it.layer(LiveTestLayer)("import routes", (test) => {
  test.effect("asks for a selection and a destination before anything can be imported", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const listing = yield* add(world);
        expect(listing).toMatchObject({
          classification: "success",
          plan: { outcome: "needs-selection" },
        });
        expect(codes(listing)).toEqual([
          "import-selection-required",
          "import-destination-required",
        ]);

        const chosen = yield* add(world, { skills: ["pdf"] });
        expect(chosen).toMatchObject({ plan: { outcome: "needs-destination" } });
        expect(codes(chosen)).toEqual(["import-destination-required"]);

        const ready = yield* add(world, { skills: ["pdf"], into: "personal-brain" });
        expect(ready).toMatchObject({ classification: "success", plan: { outcome: "ready" } });
        expect(codes(ready)).toEqual([]);
        expect(ready).not.toHaveProperty("applied");
      }),
    ),
  );

  test.effect("passes on why a destination cannot receive the import", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const outcome = yield* add(world, {
          skills: ["pdf"],
          into: "personal-brain:missing/folder",
        });
        expect(outcome).toMatchObject({ plan: { outcome: "refused" } });
        const plan = outcome.plan;
        if (typeof plan !== "object" || plan === null) throw new Error("The preview has no plan.");
        const refusal: unknown = Reflect.get(plan, "refusal");
        if (typeof refusal !== "object" || refusal === null)
          throw new Error("The plan has no refusal.");
        // A refused destination is no destination, so the destination reminder stays.
        expect(outcome.diagnostics).toEqual([
          expect.objectContaining({ code: "import-destination-required" }),
          { ...refusal, severity: "warning" },
        ]);
      }),
    ),
  );

  test.effect("says when a location offers nothing to import", () =>
    withImportWorld(
      { declaration, files, commits: [{ files: { "README.md": "no skills here\n" } }] },
      (world) =>
        Effect.gen(function* () {
          const outcome = yield* add(world, { into: "personal-brain" });
          expect(outcome).toMatchObject({ plan: { outcome: "nothing-importable" } });
          expect(codes(outcome)).toEqual(["import-nothing-importable"]);
        }),
    ),
  );

  test.effect("imports, lists and removes one skill, previewing the removal first", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const imported = yield* add(world, {
          skills: ["pdf"],
          into: "personal-brain",
          apply: true,
        });
        expect(imported).toMatchObject({
          classification: "success",
          diagnostics: [],
          applied: { kind: "import-application" },
        });
        expect(yield* fileSystem.exists(`${world.root}/skills/pdf/SKILL.md`)).toBe(true);

        const listed = yield* routeOutcome(
          importRoutes["import-list"].run({ _tag: "import-list" }, world.options),
        );
        expect(listed).toMatchObject({
          classification: "success",
          result: { imports: [{ reference: "personal-brain:pdf" }] },
        });

        const preview = yield* remove(world, false);
        expect(preview).toMatchObject({ classification: "success", plan: expect.anything() });
        expect(preview).not.toHaveProperty("applied");
        expect(yield* fileSystem.exists(`${world.root}/skills/pdf`)).toBe(true);

        const removed = yield* remove(world, true);
        expect(removed).toMatchObject({
          classification: "success",
          plan: expect.anything(),
          applied: { kind: "import-removal-application", reference: "personal-brain:pdf" },
        });
        expect(yield* fileSystem.exists(`${world.root}/skills/pdf`)).toBe(false);
      }),
    ),
  );

  test.effect("reports only the application when a removal finishes an interrupted one", () =>
    withImportWorld({ declaration, files, commits: [commit] }, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* add(world, { skills: ["pdf"], into: "personal-brain", apply: true });
        // The crash hook ends the removal right after tack.yaml lost the record.
        const kill = vi.spyOn(process, "kill").mockImplementation(() => {
          throw new Error("killed");
        });
        vi.stubEnv(crashAtVariable, "tack-yaml");
        const killed = yield* remove(world, true).pipe(
          Effect.exit,
          Effect.ensuring(
            Effect.sync(() => {
              vi.unstubAllEnvs();
              kill.mockRestore();
            }),
          ),
        );
        expect(Exit.isFailure(killed)).toBe(true);
        expect(yield* fileSystem.exists(stagingPathOf(world.root))).toBe(true);

        const finished = yield* remove(world, true);
        expect(finished).not.toHaveProperty("plan");
        expect(finished).toMatchObject({
          classification: "success",
          applied: { recovered: ["Finished the interrupted removal of skills/pdf."] },
        });
      }),
    ),
  );
});
