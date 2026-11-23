import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { faultyFileSystem, platformTestError } from "../../../test/support/faults.ts";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Fiber, Path, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import {
  initializeState,
  makeStateNoticeCollector,
  mutateStateEffect,
  readState,
  resolveStateDirectory,
  StateBusyError,
  StateConfigurationError,
  StateCorruptError,
  StateFormatUnsupportedError,
  StateMutationError,
  StateNotInitializedError,
  StateStorageError,
  StateStore,
  withStateCheckpointWriter,
} from "../../services/state-store.ts";
import { emptyState, StateSchema, type State } from "../../domain/state/state-schema.ts";
import { stateFormat } from "../../domain/state/state-format.ts";
import { makeStateStoreService } from "./state.ts";
import { decodeState, encodeState } from "../../domain/state/state-codec.ts";
import { agentLink } from "../../domain/links/link-record-schema.ts";
import { docsLink } from "../../domain/docs/docs-schema.ts";
import { mutateState, runtimeFixture } from "../../../test/support/state-fixture.ts";

it("keeps the pure replacement helper out of the production state module", async () => {
  const production = await import("./state.ts");
  expect(production).not.toHaveProperty("mutateState");
});

const stateFileName = "state.json";
const dotenvFileName = ".env";
const lockFileName = "state.lock";

type StateRequirements = SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path | StateStore;

const withSecureRandom = <A, E>(
  effect: Effect.Effect<A, E, StateRequirements>,
  random: SecureRandom.SecureRandom["Service"],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* effect.pipe(
      Effect.provideService(StateStore, makeStateStoreService(random, fileSystem, path)),
      Effect.provideService(SecureRandom.SecureRandom, random),
    );
  });

const withStateDirectory = <A, E, R>(use: (stateDirectory: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "tack-state-test-",
    });

    return yield* use(stateDirectory);
  });

const stateOptions = (stateDirectory: string) => ({
  environment: { TACK_STATE_DIR: stateDirectory },
  homeDirectory: "/unused-home",
});

it.layer(LiveTestLayer)("state", (stateIt) => {
  stateIt.effect("uses TACK_STATE_DIR before the default location", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolved = yield* resolveStateDirectory({
        environment: { TACK_STATE_DIR: "relative-tack-state" },
        homeDirectory: "/operator-home",
      });

      expect(resolved).toBe(path.resolve("relative-tack-state"));
    }),
  );

  stateIt.effect("uses the operator home when TACK_STATE_DIR is absent", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveStateDirectory({
        environment: {},
        homeDirectory: "/operator-home",
      });

      expect(resolved).toBe("/operator-home/.tack");
    }),
  );

  stateIt.effect("rejects empty configured and default state directories", () =>
    Effect.gen(function* () {
      const configuredDirectoryError = yield* Effect.flip(
        resolveStateDirectory({
          environment: { TACK_STATE_DIR: "" },
          homeDirectory: "/operator-home",
        }),
      );
      const defaultDirectoryError = yield* Effect.flip(
        resolveStateDirectory({ environment: {}, homeDirectory: "" }),
      );

      expect(configuredDirectoryError).toBeInstanceOf(StateConfigurationError);
      expect(defaultDirectoryError).toBeInstanceOf(StateConfigurationError);
    }),
  );

  stateIt.effect("creates fresh format 1 state and an owner-restricted dotenv file", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* initializeState(stateOptions(stateDirectory));
        const dotenvPath = path.join(stateDirectory, dotenvFileName);
        const statePath = path.join(stateDirectory, stateFileName);
        const dotenvStatus = yield* fileSystem.stat(dotenvPath);
        const stateStatus = yield* fileSystem.stat(statePath);
        const persistedState = JSON.parse(yield* fileSystem.readFileString(statePath));

        expect(result).toEqual({ alreadyInitialized: false, stateDirectory });
        expect(persistedState).toEqual(emptyState());
        expect(yield* decodeState(persistedState)).toEqual(emptyState());
        expect(yield* fileSystem.readFileString(dotenvPath)).toBe("");
        expect(dotenvStatus.mode & 0o077).toBe(0);
        expect(stateStatus.mode & 0o077).toBe(0);
      }),
    ),
  );

  stateIt.effect("preserves the full state and operator dotenv content on repeat", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const dotenvPath = path.join(stateDirectory, dotenvFileName);
        const statePath = path.join(stateDirectory, stateFileName);
        yield* initializeState(options);
        yield* mutateState(options, (state) => ({
          ...state,
          data: { ...state.data, projects: [] },
        }));
        yield* fileSystem.writeFileString(dotenvPath, "TACK_TOKEN=operator-value\n");
        const stateBeforeRepeat = yield* fileSystem.readFileString(statePath);

        const result = yield* initializeState(options);

        expect(result).toEqual({ alreadyInitialized: true, stateDirectory });
        expect(yield* fileSystem.readFileString(statePath)).toBe(stateBeforeRepeat);
        expect(yield* fileSystem.readFileString(dotenvPath)).toBe("TACK_TOKEN=operator-value\n");
      }),
    ),
  );

  stateIt.effect("reports failures inspecting or creating the operator dotenv file", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const dotenvPath = path.join(stateDirectory, dotenvFileName);
        yield* initializeState(options);

        const inspectionError = yield* provideTestFileSystem(
          Effect.flip(initializeState(options)),
          yield* faultyFileSystem({
            stat: (targetPath) =>
              targetPath === dotenvPath ? platformTestError("stat") : undefined,
          }),
        );

        expect(inspectionError).toBeInstanceOf(StateStorageError);
        yield* fileSystem.remove(dotenvPath);

        const creationError = yield* provideTestFileSystem(
          Effect.flip(initializeState(options)),
          yield* faultyFileSystem({
            open: (targetPath) =>
              targetPath === dotenvPath ? platformTestError("open") : undefined,
          }),
        );

        expect(creationError).toBeInstanceOf(StateStorageError);
      }),
    ),
  );

  stateIt.effect("replaces state atomically after validating the mutation candidate", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        yield* initializeState(options);
        const before = yield* fileSystem.stat(statePath);

        const updated = yield* mutateState(options, (state) => ({
          ...state,
          data: { ...state.data, projects: [] },
        }));
        const after = yield* fileSystem.stat(statePath);

        expect(updated.data).toEqual(emptyState().data);
        const persisted = JSON.parse(yield* fileSystem.readFileString(statePath));
        expect(yield* decodeState(persisted)).toEqual(emptyState());
        expect(persisted.data.projects).toEqual([]);
        expect(after.ino).not.toEqual(before.ino);
        expect(
          (yield* fileSystem.readDirectory(stateDirectory)).some((entry) =>
            entry.startsWith(`${stateFileName}.tmp-`),
          ),
        ).toBe(false);
        expect(yield* readState(options)).toEqual(emptyState());
      }),
    ),
  );

  stateIt.effect("rejects unsupported complete state and an invalid mutation candidate", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        const validState = JSON.stringify(yield* encodeState(emptyState()));
        yield* fileSystem.writeFileString(statePath, JSON.stringify({ data: {}, version: 2 }));

        const readError = yield* Effect.flip(readState(options));

        expect(readError).toBeInstanceOf(StateCorruptError);

        yield* fileSystem.writeFileString(
          statePath,
          JSON.stringify({ data: { unknown: true }, version: 1 }),
        );
        const excessDataError = yield* Effect.flip(readState(options));

        expect(excessDataError).toBeInstanceOf(StateCorruptError);

        yield* fileSystem.writeFileString(statePath, validState);
        const mutationError = yield* Effect.flip(
          mutateState(options, (state) => ({
            ...state,
            data: { ...state.data, invalid: Number.NaN },
          })),
        );

        expect(mutationError).toBeInstanceOf(StateMutationError);
        expect(yield* fileSystem.readFileString(statePath)).toBe(validState);
      }),
    ),
  );

  stateIt.effect(
    "rejects malformed normalized state before writer callbacks or initialization effects",
    () =>
      withStateDirectory((stateDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const options = stateOptions(stateDirectory);
          const statePath = path.join(stateDirectory, stateFileName);
          // One document per refusal: the first field is not `format`, and the schema rejects the
          // rest. Which documents the schema rejects is owned by `domain/state`.
          const invalidDocuments = [
            { data: {}, format: 1 },
            { format: 1, data: { ...emptyState().data, docsManagedLinks: [] } },
          ];
          let mutationCalls = 0;
          let writerCalls = 0;
          for (const invalidDocument of invalidDocuments) {
            const before = JSON.stringify(invalidDocument);
            yield* fileSystem.writeFileString(statePath, before);
            expect(yield* Effect.flip(readState(options))).toBeInstanceOf(StateCorruptError);
            expect(yield* Effect.flip(initializeState(options))).toBeInstanceOf(StateCorruptError);
            expect(
              yield* Effect.flip(
                mutateState(options, (state) => {
                  mutationCalls += 1;
                  return state;
                }),
              ),
            ).toBeInstanceOf(StateCorruptError);
            expect(
              yield* Effect.flip(
                withStateCheckpointWriter(options, () => {
                  writerCalls += 1;
                  return Effect.void;
                }),
              ),
            ).toBeInstanceOf(StateCorruptError);
            expect(yield* fileSystem.readFileString(statePath)).toBe(before);
            expect(yield* fileSystem.exists(path.join(stateDirectory, dotenvFileName))).toBe(false);
            expect(yield* fileSystem.exists(path.join(stateDirectory, lockFileName))).toBe(false);
          }
          expect(mutationCalls).toBe(0);
          expect(writerCalls).toBe(0);
        }),
      ),
  );

  stateIt.effect("refuses a newer format without touching orphaned temporary files", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        const temporaryPath = `${statePath}.tmp-orphan`;
        const bytes = '{"format":99,"data":{}}';
        yield* fileSystem.writeFileString(statePath, bytes);
        yield* fileSystem.writeFileString(temporaryPath, "orphan");
        const errors = [
          yield* Effect.flip(readState(options)),
          yield* Effect.flip(initializeState(options)),
          yield* Effect.flip(mutateState(options, (state) => state)),
        ];
        for (const error of errors) {
          expect(error).toBeInstanceOf(StateFormatUnsupportedError);
          expect(error).toMatchObject({ foundFormat: 99, statePath });
          expect(yield* fileSystem.readFileString(statePath)).toBe(bytes);
          expect(yield* fileSystem.readFileString(temporaryPath)).toBe("orphan");
        }
      }),
    ),
  );

  const newestReadable = stateFormat;
  const newerDocuments = [
    // A release that reads format N must refuse N+1 whatever shape the file has.
    ["the next format with the current shape", { format: newestReadable + 1, data: {} }],
    ["the next format with an unrelated shape", { format: newestReadable + 1, projects: "x" }],
    ["a distant format without data", { format: newestReadable + 10 }],
    ["a newer format with array data", { format: newestReadable + 2, data: [] }],
    ["a newer format with no other field", { format: 1_000_000 }],
  ] as const;

  for (const [name, document] of newerDocuments) {
    stateIt.effect(`refuses ${name} as a newer format on every state entry point`, () =>
      withStateDirectory((stateDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const options = stateOptions(stateDirectory);
          const statePath = path.join(stateDirectory, stateFileName);
          const bytes = JSON.stringify(document);
          yield* fileSystem.writeFileString(statePath, bytes);
          const errors = [
            yield* Effect.flip(readState(options)),
            yield* Effect.flip(initializeState(options)),
            yield* Effect.flip(mutateState(options, (state) => state)),
            yield* Effect.flip(withStateCheckpointWriter(options, () => Effect.void)),
          ];
          for (const error of errors) {
            expect(error).toBeInstanceOf(StateFormatUnsupportedError);
            expect(error).toMatchObject({ foundFormat: document.format, statePath });
          }
          expect(yield* fileSystem.readFileString(statePath)).toBe(bytes);
        }),
      ),
    );
  }

  const corruptDocuments = [
    ["invalid JSON", "{"],
    ["a missing envelope key", '{"data":{}}'],
    ["a format that is not the first field", '{"data":{},"format":1}'],
    ["a format older than any Tack wrote", '{"format":0,"data":{}}'],
    ["a string format number", `{"format":"${newestReadable}","data":{}}`],
    ["a fractional format number", `{"format":${newestReadable}.5,"data":{}}`],
    ["a null format number", '{"format":null,"data":{}}'],
    ["an array document", "[]"],
    ["a null document", "null"],
    ["a readable format that fails decoding", `{"format":${newestReadable},"data":"x"}`],
    ["a readable format with unknown data", `{"format":${newestReadable},"data":{"unknown":true}}`],
  ] as const;

  for (const [name, bytes] of corruptDocuments) {
    stateIt.effect(`keeps ${name} as corrupt state`, () =>
      withStateDirectory((stateDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const options = stateOptions(stateDirectory);
          const statePath = path.join(stateDirectory, stateFileName);
          yield* fileSystem.writeFileString(statePath, bytes);
          expect(yield* Effect.flip(readState(options))).toBeInstanceOf(StateCorruptError);
          expect(yield* fileSystem.readFileString(statePath)).toBe(bytes);
        }),
      ),
    );
  }

  stateIt.effect(
    "preserves link records, journal entries and docs settings across checkpoints",
    () =>
      withStateDirectory((stateDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const options = stateOptions(stateDirectory);
          const statePath = path.join(stateDirectory, stateFileName);
          const sourceRegistrationId = "00000000-0000-4000-8000-000000000001";
          const address = { kind: "skill", name: "example", sourceRegistrationId } as const;
          const evidence = {
            adapter: "codex",
            address,
            sourceDirectoryPath: "/retired-source/example",
            sourceRegistrationId,
            target: {
              _tag: "project-root",
              canonicalPath: "/retired-root",
              projectName: "retired",
            },
          } as const;
          const docsEvidence = {
            projectName: "retired",
            root: "/retired-root",
            resource: { sourceRegistrationId, name: "guide" },
            destinationPath: "/retired-root/docs/guide",
            sourceDirectoryPath: "/retired-source/guide",
          } as const;
          const expected: State = runtimeFixture({
            data: {
              enabledAdapters: ["codex"],
              projects: [{ name: "active", gitCommonDirectory: "/repo/.git", roots: ["/repo"] }],
              sources: [{ id: sourceRegistrationId, canonicalPath: "/active-source" }],
              choices: [{ namespace: { _tag: "user" }, address, decision: "include" }],
              managedLinks: [evidence],
              pendingRemovals: [
                {
                  cause: "reset",
                  evidence,
                  lastResult: { _tag: "blocked", message: "Retain this obligation." },
                },
              ],
              docsManagedLinks: [docsEvidence],
              journal: [{ _tag: "remove", link: docsLink(docsEvidence) }],
              docsProjects: [
                {
                  projectName: "active",
                  attachments: [docsEvidence.resource],
                  destination: "handbook",
                  defaultWritingResource: docsEvidence.resource,
                },
              ],
            },
          });
          yield* initializeState(options);
          yield* mutateState(options, () => expected);
          const encoded = JSON.parse(yield* fileSystem.readFileString(statePath));
          expect(Object.keys(encoded)).toEqual(["format", "data"]);
          expect(encoded.format).toBe(1);
          expect(yield* decodeState(encoded)).toEqual(expected);
          expect(Object.keys(encoded.data)).toEqual([
            "enabledAdapters",
            "sources",
            "projects",
            "userChoices",
            "links",
            "journal",
          ]);
          // One ledger holds both delivery kinds, each record carrying its own destination.
          expect(
            encoded.data.links.map(
              (record: { delivery: { _tag: string } }) => record.delivery._tag,
            ),
          ).toEqual(["agent", "docs"]);
          expect(encoded.data.links[0]).toMatchObject({
            destinationPath: agentLink(evidence).destinationPath,
            resource: address,
            delivery: { _tag: "agent", adapter: "codex" },
            removal: { cause: "reset" },
          });
          expect(encoded.data.journal[0]).toMatchObject({ _tag: "remove" });
          expect(encoded.data.projects[0].docs.attachments[0]).toMatchObject({
            writingDefault: true,
          });
          const beforeRead = yield* fileSystem.readFileString(statePath);
          expect(yield* readState(options)).toEqual(expected);
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeRead);
          const updated = yield* withStateCheckpointWriter(options, (writer) =>
            Effect.gen(function* () {
              expect(writer.current()).toEqual(expected);
              yield* writer.checkpoint((state) =>
                Effect.succeed({
                  state: {
                    ...state,
                    data: { ...state.data, enabledAdapters: ["codex", "cursor"] },
                  },
                  value: undefined,
                }),
              );
              return writer.current();
            }),
          );
          expect(updated).toEqual({
            ...expected,
            data: { ...expected.data, enabledAdapters: ["codex", "cursor"] },
          });
          expect(yield* readState(options)).toEqual(updated);
        }),
      ),
  );

  stateIt.effect("keeps current state and avoids temporary files when encoding fails", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        yield* initializeState(options);
        const before = yield* fileSystem.readFileString(statePath);
        let temporaryOpenCount = 0;
        let temporaryIdCount = 0;
        const retained = {
          adapter: "codex",
          address: {
            kind: "skill",
            name: "guide",
            sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
          },
          sourceDirectoryPath: "/source/guide",
          sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
          target: { _tag: "project-root", projectName: "stale", canonicalPath: "/repo" },
        } as const;
        const invalid: State = {
          format: 1,
          data: {
            ...emptyState().data,
            links: [agentLink(retained)],
            // A prepared create that disagrees with the retained evidence for its destination.
            journal: [
              {
                _tag: "create",
                link: agentLink({ ...retained, sourceDirectoryPath: "/other/guide" }),
              },
            ],
          },
        };
        // Cross-store ownership fails before a temporary state file is opened.
        yield* Schema.decodeUnknownEffect(StateSchema)(invalid);
        yield* provideTestFileSystem(
          withSecureRandom(
            withStateCheckpointWriter(options, (writer) =>
              Effect.gen(function* () {
                const current = writer.current();
                const error = yield* Effect.flip(
                  writer.checkpoint(() => Effect.succeed({ state: invalid, value: undefined })),
                );
                expect(error).toBeInstanceOf(StateMutationError);
                expect(writer.current()).toBe(current);
              }),
            ),
            SecureRandom.make((size) => {
              temporaryIdCount += 1;
              return globalThis.crypto.getRandomValues(new Uint8Array(size));
            }),
          ),
          yield* faultyFileSystem({
            open: (targetPath) => {
              if (targetPath.startsWith(`${statePath}.tmp-`)) temporaryOpenCount += 1;
              return undefined;
            },
          }),
        );
        expect(temporaryIdCount).toBe(0);
        expect(temporaryOpenCount).toBe(0);
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
        expect(yield* fileSystem.exists(path.join(stateDirectory, lockFileName))).toBe(false);
      }),
    ),
  );

  stateIt.effect("reports a busy writer without changing state", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        yield* initializeState(options);
        const stateBeforeMutation = yield* fileSystem.readFileString(statePath);
        yield* fileSystem.open(path.join(stateDirectory, lockFileName), { flag: "wx" });

        const error = yield* Effect.flip(
          mutateState(options, (state) => ({
            ...state,
            data: { ...state.data, projects: [] },
          })),
        );

        expect(error).toBeInstanceOf(StateBusyError);
        expect(yield* fileSystem.readFileString(statePath)).toBe(stateBeforeMutation);
      }),
    ),
  );

  stateIt.effect("keeps an unreadable writer lock busy", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const lockPath = path.join(stateDirectory, lockFileName);
        yield* initializeState(options);
        yield* fileSystem.writeFileString(lockPath, "2147483647\n");
        const error = yield* provideTestFileSystem(
          Effect.flip(mutateState(options, (state) => state)),
          yield* faultyFileSystem({
            readFileString: (targetPath) =>
              targetPath === lockPath ? platformTestError("readFileString") : undefined,
          }),
        );
        expect(error).toBeInstanceOf(StateBusyError);
        expect(yield* fileSystem.readFileString(lockPath)).toBe("2147483647\n");
      }),
    ),
  );

  stateIt.effect("allows one of two racing writers to take over a dead lock", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const lockPath = path.join(stateDirectory, lockFileName);
        yield* initializeState(options);
        for (let attempt = 0; attempt < 10; attempt += 1) {
          yield* fileSystem.writeFileString(lockPath, "2147483647\n");
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const writer = () =>
            withStateCheckpointWriter(options, () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }),
            ).pipe(Effect.result);
          const first = yield* writer().pipe(Effect.forkChild);
          const second = yield* writer().pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          expect(yield* fileSystem.readFileString(lockPath)).toBe(`${process.pid}\n`);
          yield* Effect.raceFirst(Fiber.join(first), Fiber.join(second));
          yield* Deferred.succeed(release, undefined);
          const outcomes = [yield* Fiber.join(first), yield* Fiber.join(second)];
          expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
          expect(outcomes.filter((outcome) => outcome._tag === "Failure")).toHaveLength(1);
          expect(yield* fileSystem.exists(lockPath)).toBe(false);
        }
      }),
    ),
  );

  stateIt.effect("does not create state before explicit initialization", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tack-state-test-",
      });
      const stateDirectory = path.join(temporaryRoot, "state-not-initialized");
      const options = stateOptions(stateDirectory);

      const error = yield* Effect.flip(
        mutateState(options, (state) => ({
          ...state,
          data: { ...state.data, projects: [] },
        })),
      );

      expect(error).toBeInstanceOf(StateNotInitializedError);
      expect(yield* fileSystem.exists(stateDirectory)).toBe(false);
    }),
  );

  stateIt.effect("reports storage failures without creating dotenv", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tack-state-test-",
      });
      const stateDirectory = path.join(temporaryRoot, "not-a-directory");
      const statePath = path.join(stateDirectory, stateFileName);
      const options = stateOptions(stateDirectory);
      yield* fileSystem.writeFileString(stateDirectory, "not a directory");
      const initializationError = yield* Effect.flip(initializeState(options));
      const mutationError = yield* Effect.flip(
        mutateState(options, (state) => ({
          ...state,
          data: { ...state.data, projects: [] },
        })),
      );

      expect(initializationError).toBeInstanceOf(StateStorageError);
      expect(mutationError).toBeInstanceOf(StateStorageError);
      const statePathExists = yield* fileSystem
        .exists(statePath)
        .pipe(Effect.catch(() => Effect.succeed(false)));

      expect(statePathExists).toBe(false);
    }),
  );

  stateIt.effect("reports state and dotenv conflicts plus writer-lock storage failures", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        const dotenvPath = path.join(stateDirectory, dotenvFileName);
        const lockPath = path.join(stateDirectory, lockFileName);
        yield* fileSystem.makeDirectory(statePath);
        const stateError = yield* Effect.flip(initializeState(options));

        expect(stateError).toBeInstanceOf(StateStorageError);
        yield* fileSystem.remove(statePath, { recursive: true });
        yield* initializeState(options);
        yield* fileSystem.remove(dotenvPath);
        yield* fileSystem.makeDirectory(dotenvPath);
        const dotenvError = yield* Effect.flip(initializeState(options));

        expect(dotenvError).toBeInstanceOf(StateStorageError);
        const lockError = yield* provideTestFileSystem(
          Effect.flip(
            mutateState(options, (state) => ({
              ...state,
              data: { ...state.data, projects: [] },
            })),
          ),
          yield* faultyFileSystem({
            open: (targetPath) =>
              targetPath.startsWith(lockPath) ? platformTestError("open") : undefined,
          }),
        );

        expect(lockError).toBeInstanceOf(StateStorageError);
      }),
    ),
  );

  stateIt.effect("leaves no writer lock behind when publishing its owner fails", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const lockPath = path.join(stateDirectory, lockFileName);
        yield* initializeState(options);

        const failed = yield* provideTestFileSystem(
          Effect.flip(mutateState(options, (state) => state)),
          {
            ...fileSystem,
            open: (targetPath, openOptions) =>
              fileSystem.open(targetPath, openOptions).pipe(
                Effect.map((file) =>
                  targetPath.startsWith(lockPath)
                    ? new Proxy(file, {
                        get: (target, key) =>
                          key === "writeAll"
                            ? () => Effect.fail(platformTestError("writeAll"))
                            : Reflect.get(target, key),
                      })
                    : file,
                ),
              ),
          },
        );

        expect(failed).toBeInstanceOf(StateStorageError);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
        expect(
          (yield* fileSystem.readDirectory(stateDirectory)).filter((entry) =>
            entry.startsWith(lockFileName),
          ),
        ).toEqual([]);
        // The next healthy writer is not refused by a leftover lock.
        yield* mutateState(options, (state) => state);
      }),
    ),
  );

  stateIt.effect("cleans the temporary write after a failed replacement", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        yield* initializeState(options);

        const error = yield* provideTestFileSystem(
          Effect.flip(
            mutateState(options, (state) => ({
              ...state,
              data: { ...state.data, projects: [] },
            })),
          ),
          yield* faultyFileSystem({
            rename: (fromPath, toPath) =>
              fromPath.startsWith(`${statePath}.tmp-`) && toPath === statePath
                ? platformTestError("rename")
                : undefined,
          }),
        );

        expect(error).toBeInstanceOf(StateStorageError);
        expect(
          (yield* fileSystem.readDirectory(stateDirectory)).some((entry) =>
            entry.startsWith(`${stateFileName}.tmp-`),
          ),
        ).toBe(false);
      }),
    ),
  );

  stateIt.effect("reports temporary cleanup failures after a successful replacement", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        yield* initializeState(options);

        const error = yield* provideTestFileSystem(
          Effect.flip(
            mutateState(options, (state) => ({
              ...state,
              data: { ...state.data, projects: [] },
            })),
          ),
          yield* faultyFileSystem({
            remove: (targetPath) =>
              targetPath.startsWith(`${statePath}.tmp-`) ? platformTestError("remove") : undefined,
          }),
        );

        expect(error).toBeInstanceOf(StateStorageError);
        expect(yield* readState(options)).toEqual(emptyState());
      }),
    ),
  );

  stateIt.effect("reports writer-lock cleanup failures", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const lockPath = path.join(stateDirectory, lockFileName);
        yield* initializeState(options);

        const error = yield* provideTestFileSystem(
          Effect.flip(mutateState(options, (state) => state)),
          yield* faultyFileSystem({
            remove: (targetPath) =>
              targetPath === lockPath ? platformTestError("remove") : undefined,
          }),
        );

        expect(error).toBeInstanceOf(StateStorageError);
      }),
    ),
  );

  stateIt.effect("reports mutator failures without persisting invalid state", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);

        yield* initializeState(options);
        const persistedStateBeforeMutatorFailures = yield* fileSystem.readFileString(statePath);
        const thrownError = yield* Effect.flip(
          mutateState(options, () => {
            throw new Error("mutation failed");
          }),
        );
        const nonErrorThrown = yield* Effect.flip(
          mutateState(options, () => {
            throw "not an Error";
          }),
        );

        expect(thrownError).toBeInstanceOf(StateMutationError);
        expect(nonErrorThrown).toBeInstanceOf(StateMutationError);
        expect(yield* fileSystem.readFileString(statePath)).toBe(
          persistedStateBeforeMutatorFailures,
        );
      }),
    ),
  );

  stateIt.effect("rejects corrupt state before running a mutation or creating dotenv", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        const dotenvPath = path.join(stateDirectory, dotenvFileName);
        const mutationCalls: Array<undefined> = [];
        yield* fileSystem.writeFileString(statePath, "{ not valid json");

        const initializationError = yield* Effect.flip(initializeState(options));
        const mutationError = yield* Effect.flip(
          mutateState(options, (state) => {
            mutationCalls.push(undefined);
            return state;
          }),
        );

        expect(initializationError).toBeInstanceOf(StateCorruptError);
        expect(mutationError).toBeInstanceOf(StateCorruptError);
        expect(mutationCalls).toEqual([]);
        expect(yield* fileSystem.readFileString(statePath)).toBe("{ not valid json");
        expect(yield* fileSystem.exists(dotenvPath)).toBe(false);
      }),
    ),
  );

  stateIt.effect("holds the writer lock until the checkpoint callback settles", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const lockPath = path.join(stateDirectory, lockFileName);
        yield* initializeState(options);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writerFiber = yield* withStateCheckpointWriter(options, (writer) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return writer.current();
          }),
        ).pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        expect(yield* fileSystem.exists(lockPath)).toBe(true);
        const busy = yield* Effect.flip(mutateState(options, (state) => state));
        expect(busy).toBeInstanceOf(StateBusyError);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writerFiber);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
      }),
    ),
  );

  stateIt.effect("releases the writer lock when the writer is interrupted", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const lockPath = path.join(stateDirectory, lockFileName);
        yield* initializeState(options);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writerFiber = yield* withStateCheckpointWriter(options, () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return undefined;
          }),
        ).pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        expect(yield* fileSystem.exists(lockPath)).toBe(true);
        yield* Fiber.interrupt(writerFiber);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
      }),
    ),
  );

  stateIt.effect("releases the writer lock before a later mutation after interruption", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const lockPath = path.join(stateDirectory, lockFileName);
        yield* initializeState(options);
        const entered = yield* Deferred.make<void>();
        const never = yield* Deferred.make<void>();
        const writerFiber = yield* withStateCheckpointWriter(options, () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(never);
            return undefined;
          }),
        ).pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        expect(yield* fileSystem.exists(lockPath)).toBe(true);
        yield* Fiber.interrupt(writerFiber);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
        yield* mutateState(options, (state) => ({
          ...state,
          data: { ...state.data, enabledAdapters: ["codex"] },
        }));
        expect((yield* readState(options)).data.enabledAdapters).toEqual(["codex"]);
      }),
    ),
  );

  stateIt.effect("deletes state as a terminal writer transition and releases its lock", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        const lockPath = path.join(stateDirectory, lockFileName);
        const dotenvPath = path.join(stateDirectory, dotenvFileName);
        yield* initializeState(options);

        const checkpointError = yield* withStateCheckpointWriter(options, (writer) =>
          Effect.gen(function* () {
            expect(writer.stateExists()).toBe(true);
            yield* writer.deleteState();
            expect(writer.stateExists()).toBe(false);
            yield* writer.deleteState();
            return yield* Effect.flip(
              writer.checkpoint((state) => Effect.succeed({ state, value: undefined })),
            );
          }),
        );

        expect(checkpointError).toBeInstanceOf(StateMutationError);
        expect(yield* fileSystem.exists(statePath)).toBe(false);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
        expect(yield* fileSystem.exists(dotenvPath)).toBe(true);
      }),
    ),
  );

  stateIt.effect("keeps state readable when terminal deletion fails", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        yield* initializeState(options);

        const deletionError = yield* provideTestFileSystem(
          Effect.flip(withStateCheckpointWriter(options, (writer) => writer.deleteState())),
          yield* faultyFileSystem({
            remove: (targetPath) =>
              targetPath === statePath ? platformTestError("remove") : undefined,
          }),
        );

        expect(deletionError).toBeInstanceOf(StateStorageError);
        expect(yield* readState(options)).toEqual(emptyState());
      }),
    ),
  );

  stateIt.effect("does not write when a checkpoint returns the same state object", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        let renameCount = 0;
        yield* initializeState(options);
        const before = yield* fileSystem.readFileString(statePath);
        const result = yield* provideTestFileSystem(
          withStateCheckpointWriter(options, (writer) =>
            writer.checkpoint((state) => Effect.succeed({ state, value: "unchanged" })),
          ),
          yield* faultyFileSystem({
            rename: () => {
              renameCount += 1;
              return undefined;
            },
          }),
        );

        expect(result).toBe("unchanged");
        expect(renameCount).toBe(0);
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
      }),
    ),
  );

  stateIt.effect("updates current state after each successful checkpoint", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        let renameCount = 0;
        yield* initializeState(options);
        const result = yield* provideTestFileSystem(
          withStateCheckpointWriter(options, (writer) =>
            Effect.gen(function* () {
              yield* writer.checkpoint((state) =>
                Effect.succeed({
                  state: { ...state, data: { ...state.data, enabledAdapters: ["codex"] } },
                  value: "first",
                }),
              );
              expect(writer.current().data.enabledAdapters).toEqual(["codex"]);
              yield* writer.checkpoint((state) =>
                Effect.succeed({
                  state: {
                    ...state,
                    data: { ...state.data, enabledAdapters: ["codex", "cursor"] },
                  },
                  value: "second",
                }),
              );
              expect(writer.current().data.enabledAdapters).toEqual(["codex", "cursor"]);
              return writer.current();
            }),
          ),
          yield* faultyFileSystem({
            rename: () => {
              renameCount += 1;
              return undefined;
            },
          }),
        );

        expect(result.data.enabledAdapters).toEqual(["codex", "cursor"]);
        expect(renameCount).toBe(2);
        expect((yield* readState(options)).data.enabledAdapters).toEqual(["codex", "cursor"]);
        expect(yield* fileSystem.exists(`${statePath}.tmp-unexpected`)).toBe(false);
      }),
    ),
  );

  stateIt.effect("keeps current state and bytes unchanged when a checkpoint write fails", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const statePath = path.join(stateDirectory, stateFileName);
        yield* initializeState(options);
        const before = yield* fileSystem.readFileString(statePath);
        const result = yield* provideTestFileSystem(
          withStateCheckpointWriter(options, (writer) =>
            Effect.gen(function* () {
              const previous = writer.current();
              const error = yield* Effect.flip(
                writer.checkpoint((state) =>
                  Effect.succeed({
                    state: { ...state, data: { ...state.data, enabledAdapters: ["codex"] } },
                    value: "unreachable",
                  }),
                ),
              );
              expect(error).toBeInstanceOf(StateStorageError);
              expect(writer.current()).toBe(previous);
              return writer.current();
            }),
          ),
          yield* faultyFileSystem({
            rename: (_fromPath, toPath) =>
              toPath === statePath ? platformTestError("rename") : undefined,
          }),
        );

        expect(result.data).toEqual(emptyState().data);
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
        expect(yield* fileSystem.exists(path.join(stateDirectory, lockFileName))).toBe(false);
      }),
    ),
  );
  stateIt.effect("initializes the default state on the first mutation and reports where", () =>
    withStateDirectory((home) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const writes: string[] = [];
        const notices = makeStateNoticeCollector(() => writes.push("wrote"));
        const options = { environment: {}, homeDirectory: home, observer: notices.sink };
        const value = yield* mutateStateEffect(options, (state) =>
          Effect.succeed({ state, value: "first" }),
        );
        const stateDirectory = path.join(home, ".tack");

        expect(value).toBe("first");
        expect(writes).toEqual(["wrote"]);
        expect(notices.collected()).toEqual({ initialized: { stateDirectory } });
        expect(yield* readState(options)).toEqual(emptyState());
        expect(yield* fileSystem.exists(path.join(stateDirectory, dotenvFileName))).toBe(true);
        // A collector without a write callback ignores writes and reports no initialization.
        const silent = makeStateNoticeCollector();
        silent.sink.wrote();
        expect(silent.collected()).toEqual({});
      }),
    ),
  );

  stateIt.effect("enables the initial adapters only in a state the first mutation creates", () =>
    withStateDirectory((home) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const notices = makeStateNoticeCollector();
        const options = {
          environment: {},
          homeDirectory: home,
          observer: notices.sink,
          initialAdapters: Effect.succeed(["claude", "codex"] as const),
        };
        const adapters = yield* mutateStateEffect(options, (state) =>
          Effect.succeed({ state, value: state.data.enabledAdapters }),
        );

        expect(adapters).toEqual(["claude", "codex"]);
        expect(notices.collected()).toEqual({
          initialized: {
            stateDirectory: path.join(home, ".tack"),
            enabledAdapters: ["claude", "codex"],
          },
        });
        // An existing state keeps its adapters.
        const again = makeStateNoticeCollector();
        yield* mutateStateEffect(
          { ...options, observer: again.sink, initialAdapters: Effect.succeed(["pi"] as const) },
          (state) =>
            Effect.succeed({
              state: { ...state, data: { ...state.data, sources: [] } },
              value: undefined,
            }),
        );
        expect((yield* readState(options)).data.enabledAdapters).toEqual(["claude", "codex"]);
        expect(again.collected()).toEqual({});
      }),
    ),
  );

  stateIt.effect("treats a writer lock naming an impossible process as an unknown owner", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        yield* initializeState(options);
        const lockPath = path.join(stateDirectory, lockFileName);
        yield* fileSystem.writeFileString(lockPath, "99999999999999999999\n");

        const error = yield* Effect.flip(withStateCheckpointWriter(options, () => Effect.void));

        expect(error).toBeInstanceOf(StateBusyError);
        expect(error instanceof StateBusyError && error.ownerPid).toBeUndefined();
        expect(yield* fileSystem.readFileString(lockPath)).toBe("99999999999999999999\n");
      }),
    ),
  );

  stateIt.effect("removes orphaned temporary state files but not directories of that name", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        yield* initializeState(options);
        const orphan = path.join(stateDirectory, `${stateFileName}.tmp-orphan`);
        const directory = path.join(stateDirectory, `${stateFileName}.tmp-directory`);
        yield* fileSystem.writeFileString(orphan, "orphan");
        yield* fileSystem.makeDirectory(directory);

        yield* withStateCheckpointWriter(options, () => Effect.void);

        expect(yield* fileSystem.exists(orphan)).toBe(false);
        expect(yield* fileSystem.exists(directory)).toBe(true);
      }),
    ),
  );

  stateIt.effect("reports each storage failure while cleaning orphaned temporary files", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        yield* initializeState(options);
        const orphan = path.join(stateDirectory, `${stateFileName}.tmp-orphan`);
        yield* fileSystem.writeFileString(orphan, "orphan");
        const failing = (method: "readDirectory" | "stat" | "remove") =>
          faultyFileSystem({
            readDirectory: (target) =>
              method === "readDirectory" && target === stateDirectory
                ? platformTestError(method)
                : undefined,
            stat: (target) =>
              method === "stat" && target === orphan ? platformTestError(method) : undefined,
            remove: (target) =>
              method === "remove" && target === orphan ? platformTestError(method) : undefined,
          }).pipe(
            Effect.flatMap((faulty) =>
              provideTestFileSystem(
                Effect.flip(withStateCheckpointWriter(options, () => Effect.void)),
                faulty,
              ),
            ),
          );

        expect(yield* failing("readDirectory")).toMatchObject({
          _tag: "StateStorageError",
          operation: "list temporary state files",
          path: stateDirectory,
        });
        expect(yield* failing("stat")).toMatchObject({
          _tag: "StateStorageError",
          operation: "inspect temporary state file",
          path: orphan,
        });
        expect(yield* failing("remove")).toMatchObject({
          _tag: "StateStorageError",
          operation: "remove temporary state file",
          path: orphan,
        });
        expect(yield* fileSystem.readFileString(orphan)).toBe("orphan");
      }),
    ),
  );

  stateIt.effect("keeps state when its run history cannot be deleted", () =>
    withStateDirectory((stateDirectory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const options = stateOptions(stateDirectory);
        const historyPath = path.join(stateDirectory, "history");
        yield* initializeState(options);

        const deletionError = yield* provideTestFileSystem(
          Effect.flip(withStateCheckpointWriter(options, (writer) => writer.deleteState())),
          yield* faultyFileSystem({
            remove: (targetPath) =>
              targetPath === historyPath ? platformTestError("remove") : undefined,
          }),
        );

        expect(deletionError).toMatchObject({
          _tag: "StateStorageError",
          operation: "delete run history",
          path: historyPath,
        });
        expect(yield* readState(options)).toEqual(emptyState());
      }),
    ),
  );
});
