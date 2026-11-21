import { withStateFixture } from "../../../test/support/state-fixture.ts";
import { inspectSources, resolveCatalog } from "../../../test/support/snapshot-helpers.ts";

import { catalogReport } from "../../domain/sources/catalog-report.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { faultyFileSystem, platformTestError } from "../../../test/support/faults.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import {
  makeSourceService,
  registerSource,
  relocateSource,
  Source,
  SourcePathConflictError,
  SourceRegistrationNotFoundError,
  SourceStorageError,
  SourceValidationError,
} from "./source.ts";
import { readState, StateStore } from "../../services/state-store.ts";

const declarationFileName = "tack.yaml";
const stateFileName = "state.json";

const validDeclaration = () => "version: 1\nskills:\n  - path: skills\n";

type SourceRequirements =
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | Path.Path
  | Source
  | StateStore;

const withSecureRandom = <A, E>(
  effect: Effect.Effect<A, E, SourceRequirements>,
  random: SecureRandom.SecureRandom["Service"],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* effect.pipe(
      Effect.provideService(Source, makeSourceService(random, fileSystem, path)),
      Effect.provideService(SecureRandom.SecureRandom, random),
    );
  });

const platformNotFoundError = (method: string, targetPath: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    method,
    module: "source-test",
    pathOrDescriptor: targetPath,
  });

const createSource = Effect.fnUntraced(function* (
  parent: string,
  name: string,
  declaration = validDeclaration(),
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(parent, name);
  yield* fileSystem.makeDirectory(sourcePath, { recursive: true });
  yield* fileSystem.writeFileString(path.join(sourcePath, declarationFileName), declaration);

  return sourcePath;
});

it.layer(LiveTestLayer)("source registration", (sourceIt) => {
  sourceIt.effect("reports declared, derived, missing, reserved, and clashing source labels", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const random = yield* SecureRandom.SecureRandom;
        const builtinPath = yield* createSource(root, "builtin");
        const builtin = {
          canonicalPath: yield* fs.realPath(builtinPath),
          id: "00000000-0000-4000-8000-000000000010",
        };
        const sources = [
          yield* createSource(
            root,
            "first",
            "version: 1\nname: personal-brain\nmaintainers: [platform team, ada]\n",
          ),
          yield* createSource(root, "second", "version: 1\nname: personal-brain\n"),
          yield* createSource(root, "local-notes"),
          yield* createSource(root, "My Notes"),
          yield* createSource(
            root,
            "reserved",
            "version: 1\nname: tack\nskills:\n  - path: skills\n",
          ),
        ];
        for (const sourcePath of sources) yield* registerSource(options, { sourcePath });
        const reservedSkill = path.join(root, "reserved", "skills", "reserved");
        yield* fs.makeDirectory(reservedSkill, { recursive: true });
        yield* fs.writeFileString(
          path.join(reservedSkill, "SKILL.md"),
          "---\nname: reserved\ndescription: Reserved source test\n---\n",
        );
        const inspections = yield* inspectSources(options).pipe(
          Effect.provideService(Source, makeSourceService(random, fs, path, [builtin])),
        );
        const byPath = (name: string) =>
          inspections.find((source) => path.basename(source.registration.canonicalPath) === name);
        expect(byPath("first")).toMatchObject({
          status: "healthy",
          label: "personal-brain",
          labelOrigin: "clashing",
          maintainers: ["platform team", "ada"],
          labelIssues: [{ code: "source-label-clash" }],
        });
        expect(byPath("second")).toMatchObject({
          status: "healthy",
          label: "personal-brain",
          labelOrigin: "clashing",
          labelIssues: [{ code: "source-label-clash" }],
        });
        expect(byPath("first")?.labelIssues?.[0]?.message).toContain(
          byPath("second")?.registration.id,
        );
        expect(byPath("second")?.labelIssues?.[0]?.message).toContain(
          byPath("first")?.registration.id,
        );
        expect(byPath("local-notes")).toMatchObject({
          status: "healthy",
          label: "local-notes",
          labelOrigin: "derived",
        });
        expect(byPath("My Notes")).toMatchObject({ status: "healthy", labelOrigin: "none" });
        expect(byPath("My Notes")).not.toHaveProperty("label");
        expect(byPath("reserved")).toMatchObject({
          status: "healthy",
          labelOrigin: "none",
          labelIssues: [{ code: "source-label-reserved" }],
        });
        expect(byPath("reserved")).not.toHaveProperty("label");
        expect(byPath("builtin")).toMatchObject({
          status: "healthy",
          label: "tack",
          labelOrigin: "declared",
        });
        expect(byPath("builtin")?.labelIssues).toBeUndefined();
        expect(inspections.filter((source) => source.status === "unhealthy")).toEqual([]);
        const catalog = yield* resolveCatalog(options).pipe(
          Effect.provideService(Source, makeSourceService(random, fs, path, [builtin])),
        );
        expect(catalog.entries.some((entry) => entry.address.name === "reserved")).toBe(true);
        expect(
          catalogReport(catalog).issues.filter((issue) => issue.code === "source-label-reserved"),
        ).toHaveLength(1);
        expect(
          catalogReport(catalog).issues.filter((issue) => issue.code === "source-label-clash"),
        ).toHaveLength(2);
        expect(yield* fs.readFileString(path.join(root, "reserved", "tack.yaml"))).toContain(
          "name: tack",
        );
      }),
    ),
  );

  sourceIt.effect("rejects ID-shaped names and empty maintainer entries", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        for (const [name, declaration, key] of [
          ["id-name", "version: 1\nname: 0edf1f6f-c71b-40c6-bf98-fde02235a02f\n", "name"],
          ["empty-maintainer", 'version: 1\nmaintainers: ["", x]\n', "maintainers"],
        ] as const) {
          const sourcePath = yield* createSource(root, name, declaration);
          const error = yield* Effect.flip(registerSource(options, { sourcePath }));
          expect(error).toBeInstanceOf(SourceValidationError);
          expect(error.message).toContain(key);
        }
      }),
    ),
  );

  sourceIt.effect("exposes plain issue data for validation, storage, and location failures", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const requestedPath = yield* createSource(root, "source");
        const registered = yield* registerSource(options, { sourcePath: requestedPath });
        const sourcePath = registered.registration.canonicalPath;
        const service = yield* Source;
        const failures = [
          {
            observation: Effect.fail(
              new SourceValidationError({
                code: "declaration-version-unsupported",
                message: "Unsupported version.",
                sourcePath,
              }),
            ),
            expected: {
              code: "declaration-version-unsupported",
              message: "Unsupported version.",
              sourcePath,
            },
          },
          {
            observation: Effect.fail(
              new SourceStorageError({
                code: "source-access-failed",
                message: "Read refused.",
                operation: "resolve source path",
                path: sourcePath,
              }),
            ),
            expected: {
              code: "source-access-failed",
              message: "Read refused.",
              operation: "resolve source path",
              path: sourcePath,
            },
          },
          {
            observation: Effect.succeed({
              canonicalPath: `${sourcePath}/moved`,
              declaration: { version: 1 as const },
            }),
            expected: {
              code: "source-location-changed",
              message: "The registered path now resolves to a different canonical location.",
              sourcePath,
            },
          },
        ];
        for (const { observation, expected } of failures) {
          const inspected = yield* inspectSources(options).pipe(
            Effect.provideService(Source, { ...service, validate: () => observation }),
          );
          expect(Schema.decodeUnknownSync(Schema.Json)(inspected)).toEqual(inspected);
          expect(inspected).toEqual([
            { registration: expect.any(Object), status: "unhealthy", issue: expected },
          ]);
          expect(
            Object.getPrototypeOf(
              inspected[0]?.status === "unhealthy" ? inspected[0].issue : undefined,
            ),
          ).toBe(Object.prototype);
        }
      }),
    ),
  );
  sourceIt.effect("lists the docs resources a registered source declares", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourcePath = yield* createSource(root, "source");
        yield* fileSystem.makeDirectory(path.join(sourcePath, "knowledge"));
        yield* fileSystem.writeFileString(
          path.join(sourcePath, declarationFileName),
          "version: 1\ndocs:\n  - name: handbook\n    path: knowledge\n  - name: notes\n    owner: private\n    path: knowledge\n  - name: broken\n    path: missing\n",
        );
        const expected = [{ name: "handbook" }];
        expect((yield* registerSource(options, { sourcePath })).docs).toEqual(expected);
        expect(yield* registerSource(options, { sourcePath })).toMatchObject({
          alreadyRegistered: true,
          docs: expected,
        });
        const plain = yield* createSource(root, "plain");
        expect((yield* registerSource(options, { sourcePath: plain })).docs).toEqual([]);
      }),
    ),
  );
  sourceIt.effect("collapses canonical aliases and keeps one stable registration identity", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourcePath = yield* createSource(root, "source");
        const aliasPath = path.join(root, "source-alias");
        yield* fileSystem.symlink(sourcePath, aliasPath);

        const first = yield* registerSource(options, { sourcePath });
        const repeated = yield* registerSource(options, { sourcePath });
        const aliased = yield* registerSource(options, { sourcePath: aliasPath });
        const unchangedRelocation = yield* relocateSource(options, {
          registrationId: first.registration.id,
          sourcePath,
        });
        const state = yield* readState(options);

        expect(first.alreadyRegistered).toBe(false);
        expect(repeated.alreadyRegistered).toBe(true);
        expect(aliased.alreadyRegistered).toBe(true);
        expect(repeated.registration.id).toBe(first.registration.id);
        expect(aliased.registration.id).toBe(first.registration.id);
        expect(first.registration.canonicalPath).toBe(yield* fileSystem.realPath(sourcePath));
        expect(unchangedRelocation.relocated).toBe(false);
        expect(state.data.sources).toEqual([first.registration]);
      }),
    ),
  );

  sourceIt.effect("relocates explicitly while preserving identity", () =>
    withStateFixture(({ options, root, stateDirectory }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourcePath = yield* createSource(root, "source-before-move");
        const movedPath = path.join(root, "source-after-move");
        const registered = yield* registerSource(options, { sourcePath });
        yield* fileSystem.rename(sourcePath, movedPath);
        const statePath = path.join(stateDirectory, stateFileName);
        const stateBeforeInspection = yield* fileSystem.readFileString(statePath);

        const beforeRelocation = yield* inspectSources(options);

        expect(beforeRelocation).toMatchObject([
          {
            issue: { code: "source-missing" },
            registration: { id: registered.registration.id },
            status: "unhealthy",
          },
        ]);
        expect(yield* fileSystem.readFileString(statePath)).toBe(stateBeforeInspection);

        const relocated = yield* relocateSource(options, {
          registrationId: registered.registration.id,
          sourcePath: movedPath,
        });
        const afterRelocation = yield* inspectSources(options);

        expect(relocated.relocated).toBe(true);
        expect(relocated.registration.id).toBe(registered.registration.id);
        expect(relocated.registration.canonicalPath).toBe(yield* fileSystem.realPath(movedPath));
        expect(afterRelocation).toMatchObject([
          { registration: relocated.registration, status: "healthy" },
        ]);
      }),
    ),
  );

  sourceIt.effect("retains a deleted source and reports it unhealthy without writing state", () =>
    withStateFixture(({ options, root, stateDirectory }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourcePath = yield* createSource(root, "source");
        const registered = yield* registerSource(options, { sourcePath });
        yield* fileSystem.remove(sourcePath, { recursive: true });
        const statePath = path.join(stateDirectory, stateFileName);
        const stateBeforeInspection = yield* fileSystem.readFileString(statePath);

        const inspection = yield* inspectSources(options);
        const state = yield* readState(options);

        expect(inspection).toMatchObject([
          {
            issue: { code: "source-missing" },
            registration: { id: registered.registration.id },
            status: "unhealthy",
          },
        ]);
        expect(state.data.sources).toEqual([registered.registration]);
        expect(yield* fileSystem.readFileString(statePath)).toBe(stateBeforeInspection);
      }),
    ),
  );

  sourceIt.effect("reports a canonical target change as unhealthy without following it", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourcePath = yield* createSource(root, "source-before-move");
        const movedPath = path.join(root, "source-after-move");
        const registered = yield* registerSource(options, { sourcePath });
        yield* fileSystem.rename(sourcePath, movedPath);
        yield* fileSystem.symlink(movedPath, sourcePath);

        const inspection = yield* inspectSources(options);

        expect(inspection).toMatchObject([
          {
            issue: { code: "source-location-changed" },
            registration: { id: registered.registration.id },
            status: "unhealthy",
          },
        ]);
      }),
    ),
  );

  sourceIt.effect("classifies every rejected path and declaration without changing state", () =>
    withStateFixture(({ options, root, stateDirectory }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const statePath = path.join(stateDirectory, stateFileName);
        const invalidCases = [
          { code: "source-missing", declaration: undefined, kind: "missing" },
          { code: "source-not-directory", declaration: undefined, kind: "file" },
          { code: "declaration-missing", declaration: undefined, kind: "directory" },
          { code: "declaration-malformed", declaration: "version: [", kind: "declaration" },
          {
            code: "declaration-root-not-mapping",
            declaration: "[version, owner, kind]\n",
            kind: "declaration",
          },
          {
            code: "declaration-schema-invalid",
            declaration: "owner: invalid\nversion: 1",
            kind: "declaration",
          },
          {
            code: "declaration-schema-invalid",
            declaration: `${validDeclaration()}extra: true\n`,
            kind: "declaration",
          },
          {
            code: "declaration-version-unsupported",
            declaration: "version: 99\nowner: team\nkind: skill\n",
            kind: "declaration",
          },
          {
            code: "declaration-schema-invalid",
            declaration: "version: 1\nowner: team\nkind: command\n",
            kind: "declaration",
          },
        ] as const;
        const stateBeforeFailures = yield* fileSystem.readFileString(statePath);

        yield* Effect.forEach(invalidCases, (invalidCase, index) =>
          Effect.gen(function* () {
            const sourcePath = path.join(root, `invalid-${index}`);

            if (invalidCase.kind === "file") {
              yield* fileSystem.writeFileString(sourcePath, "not a directory");
            }
            if (invalidCase.kind === "directory") {
              yield* fileSystem.makeDirectory(sourcePath);
            }
            if (invalidCase.kind === "declaration") {
              yield* fileSystem.makeDirectory(sourcePath);
              yield* fileSystem.writeFileString(
                path.join(sourcePath, declarationFileName),
                invalidCase.declaration,
              );
            }

            const error = yield* Effect.flip(registerSource(options, { sourcePath }));

            expect(error).toBeInstanceOf(SourceValidationError);
            expect(error).toMatchObject({ code: invalidCase.code });
            expect(yield* fileSystem.readFileString(statePath)).toBe(stateBeforeFailures);
          }),
        );
      }),
    ),
  );

  sourceIt.effect("rejects relocation conflicts and unknown registration identities", () =>
    withStateFixture(({ options, root, stateDirectory }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const firstPath = yield* createSource(root, "first", validDeclaration());
        const secondPath = yield* createSource(root, "second", validDeclaration());
        const thirdPath = yield* createSource(root, "third", validDeclaration());
        const first = yield* registerSource(options, { sourcePath: firstPath });
        yield* registerSource(options, { sourcePath: secondPath });
        const statePath = path.join(stateDirectory, stateFileName);
        const stateBeforeFailures = yield* fileSystem.readFileString(statePath);

        const conflict = yield* Effect.flip(
          relocateSource(options, {
            registrationId: first.registration.id,
            sourcePath: secondPath,
          }),
        );
        const notFound = yield* Effect.flip(
          relocateSource(options, {
            registrationId: "00000000-0000-4000-8000-000000000000",
            sourcePath: firstPath,
          }),
        );

        expect(conflict).toBeInstanceOf(SourcePathConflictError);
        expect(conflict).toMatchObject({ code: "source-path-already-registered" });
        expect(notFound).toBeInstanceOf(SourceRegistrationNotFoundError);
        expect(notFound).toMatchObject({ code: "registration-not-found" });
        expect(yield* fileSystem.readFileString(statePath)).toBe(stateBeforeFailures);

        const relocated = yield* relocateSource(options, {
          registrationId: first.registration.id,
          sourcePath: thirdPath,
        });

        expect(relocated.registration.canonicalPath).toBe(yield* fileSystem.realPath(thirdPath));
        expect((yield* readState(options)).data.sources).toHaveLength(2);
      }),
    ),
  );

  sourceIt.effect("maps platform failures without persisting a registration", () =>
    withStateFixture(({ options, root, stateDirectory }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourcePath = yield* createSource(root, "source");
        const declarationPath = path.join(sourcePath, declarationFileName);
        const statePath = path.join(stateDirectory, stateFileName);
        const stateBeforeFailures = yield* fileSystem.readFileString(statePath);
        const canonicalPath = yield* fileSystem.realPath(sourcePath);
        const realPathError = yield* provideTestFileSystem(
          Effect.flip(registerSource(options, { sourcePath })),
          yield* faultyFileSystem({
            realPath: (targetPath) =>
              targetPath === path.resolve(sourcePath) ? platformTestError("realPath") : undefined,
          }),
        );
        const statMissing = yield* provideTestFileSystem(
          Effect.flip(registerSource(options, { sourcePath })),
          yield* faultyFileSystem({
            stat: (targetPath) =>
              targetPath === canonicalPath ? platformNotFoundError("stat", targetPath) : undefined,
          }),
        );
        const statError = yield* provideTestFileSystem(
          Effect.flip(registerSource(options, { sourcePath })),
          yield* faultyFileSystem({
            stat: (targetPath) =>
              targetPath === canonicalPath ? platformTestError("stat") : undefined,
          }),
        );
        const declarationError = yield* provideTestFileSystem(
          Effect.flip(registerSource(options, { sourcePath })),
          yield* faultyFileSystem({
            readFileString: (targetPath) =>
              targetPath === declarationPath ||
              targetPath === path.join(canonicalPath, declarationFileName)
                ? platformTestError("readFileString")
                : undefined,
          }),
        );
        expect(realPathError).toBeInstanceOf(SourceStorageError);
        expect(realPathError).toMatchObject({ code: "source-access-failed" });
        expect(statMissing).toBeInstanceOf(SourceValidationError);
        expect(statMissing).toMatchObject({ code: "source-missing" });
        expect(statError).toBeInstanceOf(SourceStorageError);
        expect(statError).toMatchObject({ code: "source-access-failed" });
        expect(declarationError).toBeInstanceOf(SourceStorageError);
        expect(declarationError).toMatchObject({ code: "declaration-access-failed" });
        expect(yield* fileSystem.readFileString(statePath)).toBe(stateBeforeFailures);

        const registered = yield* registerSource(options, { sourcePath });
        // A repeated registration keeps its identity, so it never draws a new UUID.
        const repeatedWithoutUuid = yield* withSecureRandom(
          registerSource(options, { sourcePath }),
          SecureRandom.make(() => {
            throw new Error("A repeated registration generated a UUID.");
          }),
        );

        expect(repeatedWithoutUuid.registration.id).toBe(registered.registration.id);
      }),
    ),
  );

  sourceIt.effect("keeps a built-in source out of operator state and refuses relocation", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const random = yield* SecureRandom.SecureRandom;
        const canonicalPath = yield* fs.realPath(yield* createSource(root, "builtin"));
        const registration = { canonicalPath, id: "00000000-0000-4000-8000-000000000010" };
        const skillDirectory = path.join(canonicalPath, "skills", "use-tack");
        yield* fs.makeDirectory(skillDirectory, { recursive: true });
        yield* fs.writeFileString(
          path.join(skillDirectory, "SKILL.md"),
          "---\nname: use-tack\ndescription: Built-in test skill\n---\n",
        );
        yield* Effect.gen(function* () {
          expect(yield* registerSource(options, { sourcePath: canonicalPath })).toEqual({
            alreadyRegistered: true,
            docs: [],
            registration,
          });
          expect((yield* readState(options)).data.sources).toEqual([]);
          expect((yield* resolveCatalog(options)).entries).toMatchObject([
            { origin: "builtin", address: { name: "use-tack" } },
          ]);

          expect(yield* inspectSources(options)).toMatchObject([
            { origin: "builtin", registration, status: "healthy" },
          ]);
          expect(
            yield* Effect.flip(
              relocateSource(options, {
                registrationId: registration.id,
                sourcePath: canonicalPath,
              }),
            ),
          ).toBeInstanceOf(SourceRegistrationNotFoundError);
        }).pipe(Effect.provideService(Source, makeSourceService(random, fs, path, [registration])));
      }),
    ),
  );

  sourceIt.effect("deduplicates an older operator registration of the bundled directory", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const random = yield* SecureRandom.SecureRandom;
        const sourcePath = yield* createSource(root, "builtin");
        const registered = yield* registerSource(options, { sourcePath });
        const builtin = { ...registered.registration, id: "00000000-0000-4000-8000-000000000010" };
        const inspections = yield* inspectSources(options).pipe(
          Effect.provideService(Source, makeSourceService(random, fs, path, [builtin])),
        );
        expect(inspections).toMatchObject([
          { origin: "builtin", registration: builtin, status: "healthy" },
        ]);
        expect((yield* readState(options)).data.sources).toEqual([registered.registration]);
      }),
    ),
  );

  sourceIt.effect("reports an unavailable built-in source and recovers without registration", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const random = yield* SecureRandom.SecureRandom;
        const normal = yield* registerSource(options, {
          sourcePath: yield* createSource(root, "normal"),
        });
        const canonicalPath = path.join(yield* fs.realPath(root), "builtin");
        const builtin = { canonicalPath, id: "00000000-0000-4000-8000-000000000010" };
        yield* Effect.gen(function* () {
          expect(yield* inspectSources(options)).toMatchObject([
            { origin: "builtin", status: "unhealthy", issue: { code: "source-missing" } },
            { registration: normal.registration, status: "healthy" },
          ]);
          yield* createSource(root, "builtin");
          expect(yield* inspectSources(options)).toMatchObject([
            { origin: "builtin", registration: builtin, status: "healthy" },
            { registration: normal.registration, status: "healthy" },
          ]);
          expect((yield* readState(options)).data.sources).toEqual([normal.registration]);
        }).pipe(Effect.provideService(Source, makeSourceService(random, fs, path, [builtin])));
      }),
    ),
  );

  sourceIt.effect("rejects relocation of an operator source onto the bundled directory", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const random = yield* SecureRandom.SecureRandom;
        const canonicalPath = yield* fs.realPath(yield* createSource(root, "builtin"));
        const builtin = { canonicalPath, id: "00000000-0000-4000-8000-000000000010" };
        const normal = yield* registerSource(options, {
          sourcePath: yield* createSource(root, "normal"),
        });
        const result = yield* Effect.flip(
          relocateSource(options, {
            registrationId: normal.registration.id,
            sourcePath: canonicalPath,
          }),
        ).pipe(Effect.provideService(Source, makeSourceService(random, fs, path, [builtin])));
        expect(result).toBeInstanceOf(SourcePathConflictError);
        expect(result).toMatchObject({ conflictingRegistrationId: builtin.id });
        expect((yield* readState(options)).data.sources).toEqual([normal.registration]);
      }),
    ),
  );
});
