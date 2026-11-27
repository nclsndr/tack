import { skillText } from "../../../test/support/source-tree.ts";
import { managedLinksOf, pendingRemovalsOf } from "../../domain/links/link-record-schema.ts";
import { mutateStateFixture, stateOptionsAt } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Fiber, Path, PlatformError, Schema } from "effect";
import { enableAdapters } from "./agent.ts";
import { syncResources } from "../../../test/support/reconciliation.ts";
import {
  cleanManagedLinks,
  retrySelectedPendingRemovals,
} from "../maintenance/selected-removal.ts";
import { ReconciliationApplyResultSchema } from "./reconciliation-application.ts";
import { registerSource, relocateSource } from "../sources/source.ts";
import { runStatus } from "../status/status.ts";
import {
  initializeState,
  readState,
  StateBusyError,
  type StateOptions,
} from "../../services/state-store.ts";

it.layer(LiveTestLayer)("reconciliation command lifecycle", (reconcileIt) => {
  reconcileIt.effect("holds the state writer lock across fresh planning and application", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tack-reconcile-command-test-",
      });
      const root = yield* fileSystem.realPath(temporaryRoot);
      const homeDirectory = path.join(root, "home");
      const sourceDirectory = path.join(root, "source");
      const skillDirectory = path.join(sourceDirectory, "skills", "valid");
      const skillFilePath = path.join(skillDirectory, "SKILL.md");
      const options = stateOptionsAt(path.join(root, "state"), homeDirectory);
      yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(sourceDirectory, "tack.yaml"),
        "version: 1\nname: source\nskills:\n  - path: skills\n",
      );
      yield* fileSystem.writeFileString(
        skillFilePath,
        skillText("valid", {
          description: "Valid skill",
          tack: ["user-activation: default"],
          body: "",
        }),
      );
      yield* initializeState(options);
      yield* enableAdapters(options, ["cursor"]);
      yield* registerSource(options, { sourcePath: sourceDirectory });
      const planningStarted = yield* Deferred.make<void>();
      const continuePlanning = yield* Deferred.make<void>();
      const guardedFileSystem = {
        ...fileSystem,
        readFileString: (target: string, encoding?: string) =>
          path.basename(target) === "SKILL.md"
            ? Deferred.succeed(planningStarted, undefined).pipe(
                Effect.andThen(Deferred.await(continuePlanning)),
                Effect.andThen(fileSystem.readFileString(target, encoding)),
              )
            : fileSystem.readFileString(target, encoding),
      } satisfies FileSystem.FileSystem;
      const reconciliation = provideTestFileSystem(
        syncResources(options, {
          adapterOverride: ["cursor"],
          apply: true,
          cwd: root,
          includeOptional: false,
          selector: { _tag: "user" },
        }),
        guardedFileSystem,
      );
      const fiber = yield* Effect.forkChild(reconciliation, { startImmediately: true });
      yield* Deferred.await(planningStarted);

      const competingWriter = yield* Effect.flip(mutateStateFixture(options, (state) => state));

      expect(competingWriter).toBeInstanceOf(StateBusyError);
      yield* Deferred.succeed(continuePlanning, undefined);
      const result = yield* Fiber.join(fiber);
      expect(result.partial).toBe(false);
      const application = Schema.decodeUnknownSync(ReconciliationApplyResultSchema)(
        "application" in result ? result.application : undefined,
      );
      expect(application.units[0]?.status).toBe("success");
      expect(
        yield* fileSystem.readLink(path.join(homeDirectory, ".cursor", "skills", "valid")),
      ).not.toMatch(/^\//);
    }),
  );

  reconcileIt.effect(
    "recovers a prepared link create before planning and converges in one run",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-reconcile-command-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const homeDirectory = path.join(root, "home");
        const sourceDirectory = path.join(root, "source");
        const skillDirectory = path.join(sourceDirectory, "skills", "valid");
        const options = stateOptionsAt(path.join(root, "state"), homeDirectory);
        yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(sourceDirectory, "tack.yaml"),
          "version: 1\nname: source\nskills:\n  - path: skills\n",
        );
        yield* fileSystem.writeFileString(
          path.join(skillDirectory, "SKILL.md"),
          skillText("valid", {
            description: "Valid skill",
            tack: ["user-activation: default"],
            body: "",
          }),
        );
        yield* initializeState(options);
        yield* enableAdapters(options, ["cursor"]);
        yield* registerSource(options, { sourcePath: sourceDirectory });
        const commandOptions = {
          adapterOverride: ["cursor"],
          cwd: root,
          includeOptional: false,
          selector: { _tag: "user" },
        } as const;
        const dryRun = yield* syncResources(options, {
          ...commandOptions,
          apply: false,
        });
        const preparedAction = dryRun.plan.units
          .flatMap((unit) => unit.actions)
          .find((action) => action._tag === "link-create");
        if (preparedAction === undefined) {
          throw new Error("Expected a planned link creation.");
        }
        yield* fileSystem.makeDirectory(path.dirname(preparedAction.destinationPath), {
          recursive: true,
        });
        yield* fileSystem.symlink(preparedAction.relativeTarget, preparedAction.destinationPath);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, preparedAgentAction: { action: preparedAction } },
        }));

        const result = yield* syncResources(options, {
          ...commandOptions,
          apply: true,
        });

        expect(result.partial).toBe(false);
        expect(result.plan.units[0]?.actions).toEqual([]);
        const persisted = yield* readState(options);
        expect(persisted.data.journal).toBeUndefined();
        expect(managedLinksOf(persisted.data.links)).toHaveLength(1);
      }),
  );

  reconcileIt.effect("blocks a required unsupported capability before destination mutation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tack-reconcile-command-test-",
      });
      const root = yield* fileSystem.realPath(temporaryRoot);
      const homeDirectory = path.join(root, "home");
      const sourceDirectory = path.join(root, "source");
      const skillDirectory = path.join(sourceDirectory, "skills", "valid");
      const destinationDirectory = path.join(homeDirectory, ".claude", "skills");
      const options = stateOptionsAt(path.join(root, "state"), homeDirectory);
      yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(sourceDirectory, "tack.yaml"),
        "version: 1\nname: source\nskills:\n  - path: skills\n",
      );
      yield* fileSystem.writeFileString(
        path.join(skillDirectory, "SKILL.md"),
        skillText("valid", {
          description: "Valid skill",
          tack: ["user-activation: default"],
          body: "",
        }),
      );
      yield* initializeState(options);
      yield* enableAdapters(options, ["claude"]);
      yield* registerSource(options, { sourcePath: sourceDirectory });

      const result = yield* syncResources(options, {
        adapterOverride: ["claude"],
        apply: true,
        cwd: root,
        includeOptional: false,
        requiredCapability: "command-links",
        selector: { _tag: "user" },
      });

      expect(result.partial).toBe(true);
      expect(result.plan.units).toMatchObject([
        { actions: [], adapter: "claude", capability: { _tag: "blocked" } },
      ]);
      const application = Schema.decodeUnknownSync(ReconciliationApplyResultSchema)(
        "application" in result ? result.application : undefined,
      );
      expect(application.units).toMatchObject([{ actions: [], status: "blocked" }]);
      expect(yield* fileSystem.exists(destinationDirectory)).toBe(false);
      expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);
    }),
  );

  reconcileIt.effect("evaluates the requested command-links capability per adapter", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tack-reconcile-command-test-",
      });
      const root = yield* fileSystem.realPath(temporaryRoot);
      const homeDirectory = path.join(root, "home");
      const sourceDirectory = path.join(root, "source");
      const options = stateOptionsAt(path.join(root, "state"), homeDirectory);
      yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(sourceDirectory, "commands"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(sourceDirectory, "tack.yaml"),
        "version: 1\nname: source\ncommands:\n  - path: commands\n",
      );
      yield* fileSystem.writeFileString(
        path.join(sourceDirectory, "commands", "review.md"),
        "---\ndescription: Review\nmetadata:\n  tack: |\n    version: 1\n    user-activation: default\n---\n# Review\n",
      );
      yield* initializeState(options);
      yield* enableAdapters(options, ["claude", "cursor"]);
      yield* registerSource(options, { sourcePath: sourceDirectory });

      const result = yield* syncResources(options, {
        adapterOverride: ["claude", "cursor"],
        apply: false,
        cwd: root,
        includeOptional: false,
        requiredCapability: "command-links",
        selector: { _tag: "user" },
      });

      expect(result.partial).toBe(true);
      expect(result.plan.units).toMatchObject([
        {
          actions: [],
          adapter: "claude",
          capability: { _tag: "blocked", capability: "command-links" },
        },
        {
          actions: expect.arrayContaining([
            expect.objectContaining({
              _tag: "link-create",
              evidence: expect.objectContaining({
                address: expect.objectContaining({ kind: "command", name: "review" }),
              }),
            }),
          ]),
          adapter: "cursor",
          capability: { _tag: "supported", capability: "command-links" },
        },
      ]);
    }),
  );
});

const validSkillDocument = skillText("valid", {
  description: "Valid skill",
  tack: ["user-activation: default"],
  body: "",
});

const userReconciliation = (apply: boolean) =>
  ({
    adapterOverride: ["cursor"],
    apply,
    cwd: "/",
    includeOptional: false,
    selector: { _tag: "user" },
  }) as const;

/**
 * Builds one registered source and a home directory whose path crosses an operator symlink.
 * `layout` receives the canonical temporary root and returns the lexical home directory after
 * creating the symlinks that make that home or its agent directory resolve elsewhere.
 */
const withSymlinkedHome = <A, E, R>(
  layout: (
    root: string,
  ) => Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>,
  use: (fixture: {
    readonly destinationPath: string;
    readonly homeDirectory: string;
    readonly options: StateOptions;
    readonly skillDirectory: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "tack-reconcile-symlink-test-",
    });
    const root = yield* fileSystem.realPath(temporaryRoot);
    const sourceDirectory = path.join(root, "source");
    const skillDirectory = path.join(sourceDirectory, "skills", "valid");
    yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(sourceDirectory, "tack.yaml"),
      "version: 1\nname: source\nskills:\n  - path: skills\n",
    );
    yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), validSkillDocument);
    const homeDirectory = yield* layout(root);
    const options = stateOptionsAt(path.join(root, "state"), homeDirectory);
    yield* initializeState(options);
    yield* enableAdapters(options, ["cursor"]);
    yield* registerSource(options, { sourcePath: sourceDirectory });
    return yield* use({
      destinationPath: path.join(homeDirectory, ".cursor", "skills", "valid"),
      homeDirectory,
      options,
      skillDirectory,
    });
  });

/** A canonical home whose agent directory is a stow or chezmoi symlink at a different depth. */
const symlinkedAgentDirectory = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = path.join(root, "home");
  const dotfiles = path.join(root, "dotfiles", "stow", "cursor");
  yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
  yield* fileSystem.makeDirectory(dotfiles, { recursive: true });
  yield* fileSystem.symlink(dotfiles, path.join(homeDirectory, ".cursor"));
  return homeDirectory;
});

/** A home reached through a symlinked ancestor, like macOS `/tmp` resolving to `/private/tmp`. */
const symlinkedHomeAncestor = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realParent = path.join(root, "volumes", "data", "users");
  yield* fileSystem.makeDirectory(path.join(realParent, "home"), { recursive: true });
  yield* fileSystem.symlink(realParent, path.join(root, "users"));
  return path.join(root, "users", "home");
});

it.layer(LiveTestLayer)("reconciliation through operator symlinks", (symlinkIt) => {
  for (const [name, layout] of [
    ["a symlinked agent directory", symlinkedAgentDirectory],
    ["a symlinked home ancestor", symlinkedHomeAncestor],
  ] as const) {
    symlinkIt.effect(`creates a link that the OS resolves through ${name}`, () =>
      withSymlinkedHome(layout, ({ destinationPath, homeDirectory, options, skillDirectory }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          const result = yield* syncResources(options, userReconciliation(true));

          expect(result.partial).toBe(false);
          const application = Schema.decodeUnknownSync(ReconciliationApplyResultSchema)(
            "application" in result ? result.application : undefined,
          );
          expect(application.units.map((unit) => unit.status)).toEqual(["success"]);
          expect(yield* fileSystem.readLink(destinationPath)).not.toMatch(/^\//);
          expect(yield* fileSystem.realPath(destinationPath)).toBe(skillDirectory);

          const status = yield* runStatus(options, {
            cwd: homeDirectory,
            selector: { _tag: "user" },
          });
          expect(
            status.destinations.map((destination) => [
              destination.destinationPath,
              destination._tag,
            ]),
          ).toEqual([[destinationPath, "matching"]]);

          const replanned = yield* syncResources(options, userReconciliation(false));
          expect(replanned.partial).toBe(false);
          expect(replanned.plan.units).toMatchObject([{ actions: [], conflicts: [] }]);
        }),
      ),
    );
  }

  symlinkIt.effect("reports a link that resolves only lexically as drift, not matching", () =>
    withSymlinkedHome(
      symlinkedAgentDirectory,
      ({ destinationPath, homeDirectory, options, skillDirectory }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const lexicalText = path.relative(path.dirname(destinationPath), skillDirectory);
          yield* syncResources(options, userReconciliation(true));
          yield* fileSystem.remove(destinationPath);
          yield* fileSystem.symlink(lexicalText, destinationPath);

          const status = yield* runStatus(options, {
            cwd: homeDirectory,
            selector: { _tag: "user" },
          });
          const plan = yield* syncResources(options, userReconciliation(false));

          expect(status.destinations).toMatchObject([
            { _tag: "drift", observation: { _tag: "unresolved-relative-link" } },
          ]);
          expect(plan.partial).toBe(true);
          expect(plan.plan.units).toMatchObject([
            { actions: [], conflicts: [{ _tag: "managed-link-drift" }] },
          ]);
          expect(yield* fileSystem.readLink(destinationPath)).toBe(lexicalText);
        }),
    ),
  );
});

/** Reconciles user links for the named skills, then hands over paths for deleting their sources. */
const withReconciledSkills = <A, E, R>(
  names: ReadonlyArray<string>,
  use: (fixture: {
    readonly destination: (name: string) => string;
    readonly homeDirectory: string;
    readonly options: StateOptions;
    readonly root: string;
    readonly skill: (name: string) => string;
    readonly sourceDirectory: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-reconcile-missing-test-" }),
    );
    const homeDirectory = path.join(root, "home");
    const sourceDirectory = path.join(root, "source");
    const skill = (name: string) => path.join(sourceDirectory, "skills", name);
    const options = stateOptionsAt(path.join(root, "state"), homeDirectory);
    yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
    yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(sourceDirectory, "tack.yaml"),
      "version: 1\nname: source\nskills:\n  - path: skills\n",
    );
    yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(skill(name), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(skill(name), "SKILL.md"),
          skillText(name, { tack: ["user-activation: default"], body: "" }),
        );
      }),
    );
    yield* initializeState(options);
    yield* enableAdapters(options, ["cursor"]);
    yield* registerSource(options, { sourcePath: sourceDirectory });
    const reconciled = yield* syncResources(options, userReconciliation(true));
    expect(reconciled.partial).toBe(false);
    return yield* use({
      destination: (name) => path.join(homeDirectory, ".cursor", "skills", name),
      homeDirectory,
      options,
      root,
      skill,
      sourceDirectory,
    });
  });

const linkIsAbsent = Effect.fnUntraced(function* (destinationPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return (yield* Effect.exit(fileSystem.readLink(destinationPath)))._tag === "Failure";
});

it.layer(LiveTestLayer)(
  "reconciliation of links whose source resource was deleted",
  (missingIt) => {
    missingIt.effect("plans and applies removal of an owned link whose source was deleted", () =>
      withReconciledSkills(["valid"], ({ destination, options, skill }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(skill("valid"), { recursive: true });

          const planned = yield* syncResources(options, userReconciliation(false));

          expect(planned.partial).toBe(false);
          expect(planned.plan.units).toMatchObject([
            {
              actions: [
                {
                  _tag: "link-remove",
                  destinationPath: destination("valid"),
                  evidence: { address: { name: "valid" }, sourceDirectoryPath: skill("valid") },
                  reason: "source-missing",
                },
              ],
              conflicts: [],
            },
          ]);

          const applied = yield* syncResources(options, userReconciliation(true));

          expect(applied.partial).toBe(false);
          expect(
            Schema.decodeUnknownSync(ReconciliationApplyResultSchema)(
              "application" in applied ? applied.application : undefined,
            ).units.map((unit) => unit.status),
          ).toEqual(["success"]);
          expect(yield* linkIsAbsent(destination("valid"))).toBe(true);
          expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);
        }),
      ),
    );

    missingIt.effect("replaces an owned link left dangling by an explicit source relocation", () =>
      withReconciledSkills(["valid"], ({ destination, options, root, sourceDirectory }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const moved = path.join(root, "moved-source");
          const registration = (yield* readState(options)).data.sources?.[0];
          if (registration === undefined) throw new Error("Expected a registered source.");
          yield* fileSystem.rename(sourceDirectory, moved);
          yield* relocateSource(options, { registrationId: registration.id, sourcePath: moved });

          const applied = yield* syncResources(options, userReconciliation(true));

          expect(applied.partial).toBe(false);
          expect(applied.plan.units[0]?.actions).toMatchObject([
            { _tag: "link-remove", reason: "replace" },
            {
              _tag: "link-create",
              evidence: { sourceDirectoryPath: path.join(moved, "skills", "valid") },
            },
          ]);
          expect(yield* fileSystem.realPath(destination("valid"))).toBe(
            path.join(moved, "skills", "valid"),
          );
        }),
      ),
    );

    missingIt.effect(
      "releases a dangling link whose text Tack did not write and leaves it in place",
      () =>
        withReconciledSkills(["valid"], ({ destination, options, skill }) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const written = yield* fileSystem.readLink(destination("valid"));
            yield* fileSystem.remove(skill("valid"), { recursive: true });
            yield* fileSystem.remove(destination("valid"));
            yield* fileSystem.symlink(`./${written}`, destination("valid"));

            const applied = yield* syncResources(options, userReconciliation(true));

            expect(applied.partial).toBe(false);
            expect(applied.plan.units).toMatchObject([
              {
                actions: [
                  {
                    _tag: "evidence-retire",
                    evidence: { address: { name: "valid" } },
                    reason: "released",
                  },
                ],
                conflicts: [],
              },
            ]);
            expect(yield* fileSystem.readLink(destination("valid"))).toBe(`./${written}`);
            expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);
          }),
        ),
    );

    missingIt.effect(
      "cleans an owned dangling link and retries a foreign-text one only after its text is Tack's",
      () =>
        withReconciledSkills(["alpha", "beta"], ({ destination, homeDirectory, options, skill }) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const written = yield* fileSystem.readLink(destination("beta"));
            yield* fileSystem.remove(skill("alpha"), { recursive: true });
            yield* fileSystem.remove(skill("beta"), { recursive: true });
            yield* fileSystem.remove(destination("beta"));
            yield* fileSystem.symlink(`./${written}`, destination("beta"));
            const selected = { cwd: homeDirectory, selector: { _tag: "user" } } as const;

            const cleaned = yield* cleanManagedLinks(options, { ...selected, apply: true });

            expect(
              cleaned.plan.actions.map((action) => [action.destinationPath, action._tag]),
            ).toEqual([
              [destination("alpha"), "remove"],
              [destination("beta"), "blocked"],
            ]);
            expect(yield* linkIsAbsent(destination("alpha"))).toBe(true);
            expect(yield* fileSystem.readLink(destination("beta"))).toBe(`./${written}`);
            expect(pendingRemovalsOf((yield* readState(options)).data.links)).toMatchObject([
              { lastResult: { _tag: "blocked" } },
            ]);

            yield* fileSystem.remove(destination("beta"));
            yield* fileSystem.symlink(written, destination("beta"));
            const retried = yield* retrySelectedPendingRemovals(options, {
              ...selected,
              apply: true,
            });

            expect(retried.applied?.actions).toMatchObject([{ _tag: "applied" }]);
            expect(yield* linkIsAbsent(destination("beta"))).toBe(true);
            expect(pendingRemovalsOf((yield* readState(options)).data.links)).toEqual([]);
          }),
        ),
    );
  },
);
