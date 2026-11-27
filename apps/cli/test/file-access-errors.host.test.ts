import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import type { TerminalContextShape } from "../src/cli/human/terminal-context.ts";
import { exitCodeForEnvelope } from "../src/cli/envelope/public-outcome.ts";
import { writeTypes } from "../src/features/execution/script-types.ts";
import { applyImport } from "../src/features/imports/import.ts";
import { removeImport } from "../src/features/imports/import-removal.ts";
import { stagingPathOf } from "../src/features/imports/import-write.ts";
import { runBundleApply } from "../src/features/profiles/bundle-apply.ts";
import { runBundleExport } from "../src/features/profiles/bundle-export.ts";
import { runProfileSaveSelection } from "../src/features/profiles/profile-copy.ts";
import { faultyFileSystem } from "./support/faults.ts";
import { outsideRepositoryGit } from "./support/fake-git.ts";
import { runHost } from "./support/host-runner.ts";
import { importRequest, withImportWorld } from "./support/import-world.ts";
import { LiveTestLayer, provideTestFileSystem } from "./support/live-test-layer.ts";
import { profileFixture } from "./support/profile-fixture.ts";
import { declare, skillText } from "./support/source-tree.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

const pipe: TerminalContextShape = {
  columns: 120,
  environment: { TERM: "dumb" },
  stdinIsTerminal: false,
  stdoutIsTerminal: false,
};

const tack = (args: ReadonlyArray<string>) =>
  runHost({ args, git: outsideRepositoryGit, terminal: pipe });

/** The failure the platform reports for a path that is not there. */
const notFound = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });

const importCommit = { files: { "skills/pdf/SKILL.md": skillText("pdf") } } as const;
const importDeclaration = declare("personal-brain", "skills: [{ path: skills }]");
const importFiles = { "skills/a/SKILL.md": skillText("a") };

it.layer(LiveTestLayer)("a filesystem failure in a command", (test) => {
  test.effect(
    "profile inspect-bundle names the missing bundle, the reason and the next command",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const file = path.join(root, "typo.tgz");

        const human = (yield* tack(["profile", "inspect-bundle", file])).stdout.replace(
          /\s+/g,
          " ",
        );
        expect(human).not.toContain("internal");
        expect(human).toContain(
          `Bundle file ${file} cannot be read: it does not exist. Check the path, or run \`tack profile export --help\``,
        );

        const envelope = decodeEnvelope(
          (yield* tack(["--json", "profile", "inspect-bundle", file])).stdout,
        );
        expect(envelope).toMatchObject({
          classification: "domain",
          diagnostics: [
            {
              code: "profile-bundle-file-access-failed",
              severity: "error",
              details: { path: file, reason: "NotFound", operation: "stat" },
            },
          ],
          next: ["tack profile export --help"],
        });
        expect(exitCodeForEnvelope(envelope)).toBe(1);
      }),
  );

  test.effect("profile apply-bundle refuses a missing bundle with its path and reason", () =>
    Effect.gen(function* () {
      const { path, root, options, request, run } = yield* profileFixture;
      const file = path.join(root, "typo.tgz");
      const result = yield* run(runBundleApply(options, { ...request, file }));
      expect(result.plan).toMatchObject({
        refused: true,
        findings: [
          {
            code: "profile-bundle-file-access-failed",
            message: expect.stringContaining(
              `Bundle file ${file} cannot be read: it does not exist.`,
            ),
          },
        ],
      });
    }),
  );

  test.effect("profile export names the output it cannot write and the reason", () =>
    Effect.gen(function* () {
      const { path, root, options } = yield* profileFixture;
      const output = path.join(root, "missing", "ci.tgz");
      const error = yield* Effect.flip(
        runBundleExport(options, { reference: "tools:ci", output, apply: true }),
      );
      expect(error).toMatchObject({
        _tag: "BundleError",
        code: "profile-bundle-file-access-failed",
        message: `Tack could not access ${output}: it does not exist.`,
        path: output,
        reason: "NotFound",
      });
    }),
  );

  test.effect("profile save names the source file it cannot write and the reason", () =>
    Effect.gen(function* () {
      const { path, source, options } = yield* profileFixture;
      const file = path.join(source, "profiles", "copied.yaml");
      const save = runProfileSaveSelection(options, {
        input: { user: false, projectName: "ci" },
        sourcePath: source,
        name: "copied",
        edit: false,
        apply: true,
      });
      const error = yield* Effect.flip(
        provideTestFileSystem(
          save,
          yield* faultyFileSystem({
            rename: (_from, to) => (to === file ? notFound("rename", file) : undefined),
          }),
        ),
      );
      expect(error).toMatchObject({
        _tag: "SourceStorageError",
        code: "source-access-failed",
        message: `Tack could not access ${file}: it does not exist.`,
        operation: "save profile",
        path: file,
      });
    }),
  );

  test.effect("types names the source file it cannot read and the reason", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* fs.writeFileString(path.join(root, "tack.yaml"), "version: 1\nname: tools\n");
      const stub = path.join(root, "tack-env.d.ts");
      yield* fs.writeFileString(stub, "// stale\n");
      const error = yield* Effect.flip(
        provideTestFileSystem(
          writeTypes(root, "0.0.0", false),
          yield* faultyFileSystem({
            readFileString: (file) =>
              file === stub ? notFound("readFileString", stub) : undefined,
          }),
        ),
      );
      expect(error).toMatchObject({
        _tag: "SourceStorageError",
        code: "source-access-failed",
        message: `Tack could not access ${stub}: it does not exist.`,
        operation: "write editor types",
        path: stub,
      });
    }).pipe(Effect.scoped),
  );

  /** Fails creating the source's import staging folder, the first write of an import or removal. */
  const unwritableStaging = (root: string) =>
    faultyFileSystem({
      makeDirectory: (folder) =>
        folder === stagingPathOf(root) ? notFound("makeDirectory", folder) : undefined,
    });

  test.effect("import add names the folder it cannot write and the reason", () =>
    withImportWorld(
      { declaration: importDeclaration, files: importFiles, commits: [importCommit] },
      (world) =>
        Effect.gen(function* () {
          const staging = stagingPathOf(world.root);
          const error = yield* Effect.flip(
            provideTestFileSystem(
              applyImport(
                world.options,
                importRequest({ into: "personal-brain", skills: ["pdf"] }),
              ),
              yield* unwritableStaging(world.root),
            ),
          );
          expect(error).toMatchObject({
            _tag: "ImportError",
            code: "import-write-failed",
            message: `Tack could not access ${staging}: it does not exist.`,
            details: { path: staging, reason: "NotFound", operation: "makeDirectory" },
          });
        }),
    ),
  );

  test.effect("import remove names the folder it cannot write and the reason", () =>
    withImportWorld(
      { declaration: importDeclaration, files: importFiles, commits: [importCommit] },
      (world) =>
        Effect.gen(function* () {
          yield* applyImport(
            world.options,
            importRequest({ into: "personal-brain", skills: ["pdf"] }),
          );
          const staging = stagingPathOf(world.root);
          const error = yield* Effect.flip(
            provideTestFileSystem(
              removeImport(world.options, "personal-brain:pdf", false),
              yield* unwritableStaging(world.root),
            ),
          );
          expect(error).toMatchObject({
            _tag: "ImportError",
            code: "import-write-failed",
            message: `Tack could not access ${staging}: it does not exist.`,
            details: { path: staging, reason: "NotFound", operation: "makeDirectory" },
          });
        }),
    ),
  );
});
