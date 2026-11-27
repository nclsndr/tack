import { managedLinksOf } from "../../domain/links/link-record-schema.ts";
import {
  expectWriterGuarded,
  mutateStateFixture,
  stateOptionsAt,
} from "../../../test/support/state-fixture.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { faultyFileSystem, platformTestError, stallAt } from "../../../test/support/faults.ts";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Fiber, Path, Schema } from "effect";
import { agentAdapterDescriptor } from "../../domain/agents/agent-adapter.ts";
import type { Namespace } from "../../domain/choices/choice-schema.ts";
import type { DependencyResolution } from "../../domain/choices/dependency-resolution.ts";
import {
  type ManagedLinkEvidence,
  type ManagedLinkTarget,
} from "../../domain/links/managed-link-schema.ts";
import { ReconciliationApplyResultSchema } from "./reconciliation-application.ts";
import { stateManagedLinks, statePendingRemovals } from "../removal/removal-plan.ts";
import {
  planReconciliation,
  reconciliationNamespaces,
  type NamespaceDependencyResolution,
  type PlanReconciliationInput,
} from "./reconciliation.ts";
import {
  applyReconciliationPlan,
  planAndApplyReconciliation,
} from "../../../test/support/reconciliation.ts";

import type { SkillCatalogEntry } from "../../domain/sources/catalog-schema.ts";
import {
  initializeState,
  readState,
  StateMutationError,
  type StateOptions,
} from "../../services/state-store.ts";

/** The address of a skill, as a catalog entry carries it. */
type SkillAddress = SkillCatalogEntry["address"];

const registrationId = "00000000-0000-4000-8000-000000000001";
const userNamespace = { _tag: "user" } satisfies Namespace;

const address = (name: string, owner: "shared" | "private" = "shared") =>
  ({
    kind: "skill",
    name,
    sourceRegistrationId:
      owner === "shared" ? registrationId : "00000000-0000-4000-8000-000000000002",
  }) satisfies SkillAddress;

const catalogEntry = (
  name: string,
  sourceDirectoryPath: string,
  owner: "shared" | "private" = "shared",
) =>
  ({
    activation: "default",
    address: address(name, owner),
    dependencies: [],
    description: `${name} description`,
    directoryPath: sourceDirectoryPath,
    frontmatter: { description: `${name} description`, name },
    projects: [],
    skillFilePath: `${sourceDirectoryPath}/SKILL.md`,
    sourcePath: `/sources/${owner}`,
    sourceRegistrationId: registrationId,
  }) satisfies SkillCatalogEntry;

const targetUser = (canonicalPath: string) =>
  ({ _tag: "user", canonicalPath }) satisfies ManagedLinkTarget;

const resolution = (addresses: ReadonlyArray<SkillAddress>): DependencyResolution => ({
  groups: addresses.map((member) => ({ _tag: "selected", members: [member] })),
  optionalSkips: [],
  requestBlockers: [],
});

const namespaceResolution = (addresses: ReadonlyArray<SkillAddress>) =>
  ({
    namespace: userNamespace,
    resolution: resolution(addresses),
  }) satisfies NamespaceDependencyResolution;

const evidence = (
  adapter: ManagedLinkEvidence["adapter"],
  target: ManagedLinkTarget,
  entry: SkillCatalogEntry,
) =>
  ({
    adapter,
    address: entry.address,
    sourceDirectoryPath: entry.directoryPath,
    sourceRegistrationId: entry.sourceRegistrationId,
    target,
  }) satisfies ManagedLinkEvidence;

const stateDirectorySuffix = "/state";

const homeDirectoryFromStateDirectory = (stateDirectory: string) =>
  `${stateDirectory.slice(0, -stateDirectorySuffix.length)}/home`;

const stateOptions = (stateDirectory: string, homeDirectory?: string) =>
  stateOptionsAt(
    stateDirectory,
    homeDirectory ?? homeDirectoryFromStateDirectory(stateDirectory),
  ) satisfies StateOptions;

const withTemporaryRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "tack-apply-test-",
    });
    return yield* use(yield* fileSystem.realPath(temporaryRoot));
  });

/** Recovers journals, then plans with the recovered managed links and applies that plan. */
const replan = (options: StateOptions, input: Omit<PlanReconciliationInput, "managedLinks">) =>
  planAndApplyReconciliation(options, (state) =>
    planReconciliation({ ...input, managedLinks: managedLinksOf(state.data.links) }),
  );

it.layer(LiveTestLayer)("safe reconciliation application", (applyIt) => {
  applyIt.effect("creates only relative links and checkpoints ownership", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(home, { recursive: true });
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [entry],
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([entry.address])],
            [targetUser(home)],
          ),
        });

        const result = yield* applyReconciliationPlan(options, plan);
        const destination = path.join(home, ".cursor", "skills", "skill");
        const persisted = yield* readState(options);

        expect(result.units[0]?.status).toBe("success");
        expect(yield* fileSystem.readLink(destination)).toBe(
          path.relative(path.dirname(destination), source),
        );
        expect(managedLinksOf(persisted.data.links)).toHaveLength(1);
        expect(persisted.data.journal).toBeUndefined();
        expect(Schema.decodeUnknownSync(ReconciliationApplyResultSchema)(result)).toEqual(result);
      }),
    ),
  );

  applyIt.effect("removes verified links and retires absent evidence", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const destination = path.join(home, ".cursor", "skills", "skill");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.symlink(path.relative(path.dirname(destination), source), destination);
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const managed = evidence("cursor", targetUser(home), entry);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, agentLinks: [managed] },
        }));

        const removePlan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [],
          managedLinks: [managed],
          namespaces: reconciliationNamespaces([namespaceResolution([])], [targetUser(home)]),
        });
        const removed = yield* applyReconciliationPlan(options, removePlan);
        expect(removed.units[0]?.status).toBe("success");
        expect(yield* fileSystem.exists(destination)).toBe(false);
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);

        const absentPlan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [],
          managedLinks: [managed],
          namespaces: reconciliationNamespaces([namespaceResolution([])], [targetUser(home)]),
        });
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, agentLinks: [managed] },
        }));
        const retired = yield* applyReconciliationPlan(options, absentPlan);
        expect(retired.units[0]?.actions[0]?._tag).toBe("applied");
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);
      }),
    ),
  );

  applyIt.effect("releases a changed link by forgetting its record and leaving the link", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(path.join(root, "state"));
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const elsewhere = path.join(root, "elsewhere", "skill");
        const destination = path.join(home, ".cursor", "skills", "skill");
        const changedText = path.relative(path.dirname(destination), elsewhere);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(elsewhere, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.symlink(changedText, destination);
        yield* initializeState(options);
        const managed = evidence("cursor", targetUser(home), catalogEntry("skill", source));
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, agentLinks: [managed] },
        }));
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [],
          managedLinks: [managed],
          namespaces: reconciliationNamespaces([namespaceResolution([])], [targetUser(home)]),
        });

        const released = yield* applyReconciliationPlan(options, plan);

        expect(released.units[0]).toMatchObject({
          actions: [{ _tag: "applied", action: { _tag: "evidence-retire", reason: "released" } }],
          status: "success",
        });
        expect(yield* fileSystem.readLink(destination)).toBe(changedText);
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);
      }),
    ),
  );

  applyIt.effect("keeps the record of a released link that is Tack's own link again", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const options = stateOptions(path.join(root, "state"));
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const elsewhere = path.join(root, "elsewhere", "skill");
        const destination = path.join(home, ".cursor", "skills", "skill");
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(elsewhere, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.symlink(path.relative(path.dirname(destination), elsewhere), destination);
        yield* initializeState(options);
        const managed = evidence("cursor", targetUser(home), catalogEntry("skill", source));
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, agentLinks: [managed] },
        }));
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [],
          managedLinks: [managed],
          namespaces: reconciliationNamespaces([namespaceResolution([])], [targetUser(home)]),
        });
        // The operator points the link back at the recorded source after the preview.
        yield* fileSystem.remove(destination);
        const ownText = path.relative(path.dirname(destination), source);
        yield* fileSystem.symlink(ownText, destination);

        const released = yield* applyReconciliationPlan(options, plan);

        expect(released.units[0]).toMatchObject({
          actions: [{ _tag: "failed", code: "destination-conflict" }],
          status: "failed",
        });
        expect(yield* fileSystem.readLink(destination)).toBe(ownText);
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([managed]);
      }),
    ),
  );

  applyIt.effect.each(["an absent link that reappears", "a release that cannot be read"] as const)(
    "keeps the record of %s before apply",
    (change) =>
      withTemporaryRoot((root) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const options = stateOptions(path.join(root, "state"));
          const home = path.join(root, "home");
          const source = path.join(root, "source", "skill");
          const destination = path.join(home, ".cursor", "skills", "skill");
          yield* fileSystem.makeDirectory(source, { recursive: true });
          yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
          if (change === "a release that cannot be read") {
            yield* fileSystem.symlink("../../../elsewhere", destination);
          }
          yield* initializeState(options);
          const managed = evidence("cursor", targetUser(home), catalogEntry("skill", source));
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: { ...state.data, agentLinks: [managed] },
          }));
          const plan = yield* planReconciliation({
            adapters: [agentAdapterDescriptor("cursor")],
            catalogEntries: [],
            managedLinks: [managed],
            namespaces: reconciliationNamespaces([namespaceResolution([])], [targetUser(home)]),
          });
          if (change === "an absent link that reappears") {
            yield* fileSystem.writeFileString(destination, "operator-owned\n");
          }

          const result = yield* provideTestFileSystem(
            applyReconciliationPlan(options, plan),
            yield* faultyFileSystem(
              change === "an absent link that reappears"
                ? {}
                : {
                    readLink: (candidate) =>
                      candidate === destination
                        ? platformTestError("read-link-released")
                        : undefined,
                    stat: (candidate) =>
                      candidate === destination ? platformTestError("stat-released") : undefined,
                  },
            ),
          );

          expect(result.units[0]).toMatchObject({
            actions: [
              {
                _tag: "failed",
                action: {
                  _tag: "evidence-retire",
                  reason: change === "an absent link that reappears" ? "absent" : "released",
                },
              },
            ],
            status: "failed",
          });
          expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([managed]);
        }),
      ),
  );

  applyIt.effect("replaces a verified link and records the new source", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const oldSource = path.join(root, "source", "old");
        const newSource = path.join(root, "source", "new");
        const destination = path.join(home, ".cursor", "skills", "moving");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(oldSource, { recursive: true });
        yield* fileSystem.makeDirectory(newSource, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.symlink(path.relative(path.dirname(destination), oldSource), destination);
        yield* initializeState(options);
        const oldEntry = catalogEntry("moving", oldSource);
        const newEntry = catalogEntry("moving", newSource);
        const oldEvidence = evidence("cursor", targetUser(home), oldEntry);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, agentLinks: [oldEvidence] },
        }));
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [newEntry],
          managedLinks: [oldEvidence],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([newEntry.address])],
            [targetUser(home)],
          ),
        });

        const create = plan.units[0]?.actions.find((action) => action._tag === "link-create");
        expect(create?._tag === "link-create" ? create.previousEvidence : undefined).toEqual(
          oldEvidence,
        );
        const result = yield* applyReconciliationPlan(options, plan);
        expect(result.units[0]?.status).toBe("success");
        expect(yield* fileSystem.readLink(destination)).toBe(
          path.relative(path.dirname(destination), newSource),
        );
        expect(managedLinksOf((yield* readState(options)).data.links)[0]?.sourceDirectoryPath).toBe(
          newSource,
        );
      }),
    ),
  );

  applyIt.effect("preserves foreign destinations while applying independent healthy actions", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const foreign = path.join(root, "foreign");
        const healthySource = path.join(root, "source", "healthy");
        const skillDirectory = path.join(home, ".cursor", "skills");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(foreign, { recursive: true });
        yield* fileSystem.makeDirectory(healthySource, { recursive: true });
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(path.join(skillDirectory, "foreign"), "keep");
        yield* initializeState(options);
        const foreignEntry = catalogEntry("foreign", path.join(root, "source", "desired-foreign"));
        const healthyEntry = catalogEntry("healthy", healthySource);
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [foreignEntry, healthyEntry],
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([foreignEntry.address, healthyEntry.address])],
            [targetUser(home)],
          ),
        });
        const result = yield* applyReconciliationPlan(options, plan);

        expect(result.units[0]?.status).toBe("partial");
        expect(result.units[0]?.actions.some((outcome) => outcome._tag === "applied")).toBe(true);
        expect(yield* fileSystem.readFileString(path.join(skillDirectory, "foreign"))).toBe("keep");
        expect(yield* fileSystem.exists(path.join(skillDirectory, "healthy"))).toBe(true);
      }),
    ),
  );

  applyIt.effect("reports an unresolved collision as partial without actions", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const sharedSource = path.join(root, "source", "shared", "skill");
        const privateSource = path.join(root, "source", "private", "skill");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(sharedSource, { recursive: true });
        yield* fileSystem.makeDirectory(privateSource, { recursive: true });
        yield* fileSystem.makeDirectory(home, { recursive: true });
        yield* initializeState(options);
        const sharedEntry = catalogEntry("skill", sharedSource, "shared");
        const privateEntry = catalogEntry("skill", privateSource, "private");
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [sharedEntry, privateEntry],
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([sharedEntry.address, privateEntry.address])],
            [targetUser(home)],
          ),
        });

        expect(plan.units[0]?.actions).toEqual([]);
        expect(plan.units[0]?.collisions).toHaveLength(1);
        expect((yield* applyReconciliationPlan(options, plan)).units[0]?.status).toBe("partial");
      }),
    ),
  );

  applyIt.effect("reports collision cleanup as partial after removing the old managed link", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const oldSource = path.join(root, "source", "old", "skill");
        const sharedSource = path.join(root, "source", "shared", "skill");
        const privateSource = path.join(root, "source", "private", "skill");
        const destination = path.join(home, ".cursor", "skills", "skill");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(oldSource, { recursive: true });
        yield* fileSystem.makeDirectory(sharedSource, { recursive: true });
        yield* fileSystem.makeDirectory(privateSource, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.symlink(path.relative(path.dirname(destination), oldSource), destination);
        yield* initializeState(options);
        const oldEntry = catalogEntry("skill", oldSource, "private");
        const sharedEntry = catalogEntry("skill", sharedSource, "shared");
        const privateEntry = catalogEntry("skill", privateSource, "private");
        const managed = evidence("cursor", targetUser(home), oldEntry);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, agentLinks: [managed] },
        }));
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [sharedEntry, privateEntry],
          managedLinks: [managed],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([sharedEntry.address, privateEntry.address])],
            [targetUser(home)],
          ),
        });

        expect(plan.units[0]?.collisions).toHaveLength(1);
        expect(plan.units[0]?.actions).toHaveLength(1);
        const result = yield* applyReconciliationPlan(options, plan);
        expect(result.units[0]?.actions[0]?._tag).toBe("applied");
        expect(result.units[0]?.status).toBe("partial");
        expect(yield* fileSystem.exists(destination)).toBe(false);
      }),
    ),
  );

  applyIt.effect("does not remove a directory in place of a managed link", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const destination = path.join(home, ".cursor", "skills", "skill");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.symlink(path.relative(path.dirname(destination), source), destination);
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const managed = evidence("cursor", targetUser(home), entry);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, agentLinks: [managed] },
        }));
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [],
          managedLinks: [managed],
          namespaces: reconciliationNamespaces([namespaceResolution([])], [targetUser(home)]),
        });
        yield* fileSystem.remove(destination);
        yield* fileSystem.makeDirectory(destination);

        const result = yield* applyReconciliationPlan(options, plan);
        expect(result.units[0]?.status).toBe("failed");
        expect((yield* fileSystem.stat(destination)).type).toBe("Directory");
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([managed]);
      }),
    ),
  );

  applyIt.effect("skips replacement creation when removal proof fails", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const oldSource = path.join(root, "source", "old");
        const newSource = path.join(root, "source", "new");
        const destination = path.join(home, ".cursor", "skills", "moving");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(oldSource, { recursive: true });
        yield* fileSystem.makeDirectory(newSource, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.symlink(path.relative(path.dirname(destination), oldSource), destination);
        yield* initializeState(options);
        const oldEntry = catalogEntry("moving", oldSource);
        const newEntry = catalogEntry("moving", newSource);
        const managed = evidence("cursor", targetUser(home), oldEntry);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, agentLinks: [managed] },
        }));
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [newEntry],
          managedLinks: [managed],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([newEntry.address])],
            [targetUser(home)],
          ),
        });
        let symlinkCalls = 0;
        const result = yield* provideTestFileSystem(
          applyReconciliationPlan(options, plan),
          yield* faultyFileSystem({
            remove: (targetPath) =>
              targetPath === destination ? platformTestError("remove-before-replace") : undefined,
            symlink: () => {
              symlinkCalls += 1;
              return undefined;
            },
          }),
        );

        expect(result.units[0]?.status).toBe("failed");
        expect(symlinkCalls).toBe(0);
        expect(yield* fileSystem.readLink(destination)).toBe(
          path.relative(path.dirname(destination), oldSource),
        );
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([managed]);
      }),
    ),
  );

  applyIt.effect("continues after an expected link creation failure", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(home, { recursive: true });
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [entry],
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([entry.address])],
            [targetUser(home)],
          ),
        });
        const result = yield* provideTestFileSystem(
          applyReconciliationPlan(options, plan),
          yield* faultyFileSystem({ symlink: () => platformTestError("symlink") }),
        );

        expect(result.units[0]?.status).toBe("partial");
        expect(result.units[0]?.actions[1]?._tag).toBe("failed");
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);
        expect((yield* readState(options)).data.journal).toBeUndefined();
      }),
    ),
  );

  applyIt.effect(
    "skips dependent links after a directory failure while another unit proceeds",
    () =>
      withTemporaryRoot((root) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stateDirectory = path.join(root, "state");
          const home = path.join(root, "home");
          const source = path.join(root, "source", "skill");
          const options = stateOptions(stateDirectory);
          yield* fileSystem.makeDirectory(source, { recursive: true });
          yield* fileSystem.makeDirectory(home, { recursive: true });
          yield* initializeState(options);
          const entry = catalogEntry("skill", source);
          const plan = yield* planReconciliation({
            adapters: [agentAdapterDescriptor("codex"), agentAdapterDescriptor("cursor")],
            catalogEntries: [entry],
            managedLinks: [],
            namespaces: reconciliationNamespaces(
              [namespaceResolution([entry.address])],
              [targetUser(home)],
            ),
          });
          let symlinkCalls = 0;
          const result = yield* provideTestFileSystem(
            applyReconciliationPlan(options, plan),
            yield* faultyFileSystem({
              makeDirectory: (directoryPath) =>
                directoryPath.includes(".cursor") ? platformTestError("mkdir-cursor") : undefined,
              symlink: (_target, linkPath) => {
                symlinkCalls += 1;
                return linkPath.includes(".cursor")
                  ? platformTestError("unexpected-cursor-symlink")
                  : undefined;
              },
            }),
          );

          expect(result.units.map((unit) => unit.status)).toEqual(["success", "failed"]);
          expect(symlinkCalls).toBe(1);
          expect(yield* fileSystem.exists(path.join(home, ".agents", "skills", "skill"))).toBe(
            true,
          );
          expect(yield* fileSystem.exists(path.join(home, ".cursor", "skills", "skill"))).toBe(
            false,
          );
        }),
      ),
  );

  applyIt.effect("settles a create that reports failure after creating the link", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(home, { recursive: true });
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [entry],
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([entry.address])],
            [targetUser(home)],
          ),
        });
        const result = yield* provideTestFileSystem(applyReconciliationPlan(options, plan), {
          ...fileSystem,
          symlink: (fromPath, toPath) =>
            fileSystem
              .symlink(fromPath, toPath)
              .pipe(Effect.andThen(Effect.fail(platformTestError("symlink-after-side-effect")))),
        });

        expect(result.units[0]?.status).toBe("success");
        expect(managedLinksOf((yield* readState(options)).data.links)).toHaveLength(1);
        expect((yield* readState(options)).data.journal).toBeUndefined();
      }),
    ),
  );

  applyIt.effect("settles a remove that reports failure after removing the link", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const destination = path.join(home, ".cursor", "skills", "skill");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.symlink(path.relative(path.dirname(destination), source), destination);
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const managed = evidence("cursor", targetUser(home), entry);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, agentLinks: [managed] },
        }));
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [],
          managedLinks: [managed],
          namespaces: reconciliationNamespaces([namespaceResolution([])], [targetUser(home)]),
        });
        const result = yield* provideTestFileSystem(applyReconciliationPlan(options, plan), {
          ...fileSystem,
          remove: (targetPath, removeOptions) =>
            targetPath === destination
              ? fileSystem
                  .remove(targetPath, removeOptions)
                  .pipe(Effect.andThen(Effect.fail(platformTestError("remove-after-side-effect"))))
              : fileSystem.remove(targetPath, removeOptions),
        });

        expect(result.units[0]?.status).toBe("success");
        expect(yield* fileSystem.exists(destination)).toBe(false);
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);
      }),
    ),
  );

  applyIt.effect("settles a directory that reports failure after creation", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(home, { recursive: true });
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [entry],
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([entry.address])],
            [targetUser(home)],
          ),
        });
        const skillDirectory = path.join(home, ".cursor", "skills");
        expect(plan.units[0]?.actions[0]).toEqual({
          _tag: "directory-create",
          directoryPath: skillDirectory,
        });
        const result = yield* provideTestFileSystem(applyReconciliationPlan(options, plan), {
          ...fileSystem,
          makeDirectory: (directoryPath, directoryOptions) =>
            fileSystem
              .makeDirectory(directoryPath, directoryOptions)
              .pipe(Effect.andThen(Effect.fail(platformTestError("mkdir-after-side-effect")))),
        });

        expect(result.units[0]?.status).toBe("success");
        expect(yield* fileSystem.exists(skillDirectory)).toBe(true);
        expect(managedLinksOf((yield* readState(options)).data.links)).toHaveLength(1);
      }),
    ),
  );

  applyIt.effect("recovers a directory create after a real fiber interruption", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const lockPath = path.join(stateDirectory, "state.lock");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(home, { recursive: true });
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const planInput = {
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [entry],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([entry.address])],
            [targetUser(home)],
          ),
        };
        const plan = yield* planReconciliation({ ...planInput, managedLinks: [] });
        const skillDirectory = path.join(home, ".cursor", "skills");
        expect(plan.units[0]?.actions[0]).toEqual({
          _tag: "directory-create",
          directoryPath: skillDirectory,
        });
        const stall = yield* stallAt("makeDirectory", skillDirectory, { when: "after" });
        const fiber = yield* provideTestFileSystem(
          applyReconciliationPlan(options, plan),
          stall.fileSystem,
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(stall.entered);
        expect(yield* fileSystem.exists(lockPath)).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
        expect((yield* readState(options)).data.journal).toBeUndefined();
        // A directory create is not journaled: it leaves no ownership to prove on recovery.

        const recovered = yield* replan(options, planInput);
        expect(recovered.units[0]?.status).toBe("success");
        expect(yield* fileSystem.exists(path.join(skillDirectory, "skill"))).toBe(true);
        expect((yield* readState(options)).data.journal).toBeUndefined();
      }),
    ),
  );

  applyIt.effect("recovers a link create after a real fiber interruption", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const destination = path.join(home, ".cursor", "skills", "skill");
        const lockPath = path.join(stateDirectory, "state.lock");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const planInput = {
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [entry],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([entry.address])],
            [targetUser(home)],
          ),
        };
        const plan = yield* planReconciliation({ ...planInput, managedLinks: [] });
        const stall = yield* stallAt("symlink", destination, { when: "after" });
        const fiber = yield* provideTestFileSystem(
          applyReconciliationPlan(options, plan),
          stall.fileSystem,
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(stall.entered);
        expect(yield* fileSystem.exists(lockPath)).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
        expect((yield* readState(options)).data.journal?.map((prepared) => prepared._tag)).toEqual([
          "create",
        ]);
        const persisted = JSON.parse(
          yield* fileSystem.readFileString(path.join(stateDirectory, "state.json")),
        );
        expect(persisted).toMatchObject({
          format: 1,
          data: { journal: [{ _tag: "create" }] },
        });
        expect(persisted.data.links).toEqual([]);

        const recovered = yield* replan(options, planInput);
        expect(recovered.units[0]?.status).toBe("success");
        expect(managedLinksOf((yield* readState(options)).data.links)).toHaveLength(1);
        expect((yield* readState(options)).data.journal).toBeUndefined();
      }),
    ),
  );

  applyIt.effect("recovers a link remove after a real fiber interruption", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const destination = path.join(home, ".cursor", "skills", "skill");
        const lockPath = path.join(stateDirectory, "state.lock");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.symlink(path.relative(path.dirname(destination), source), destination);
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const managed = evidence("cursor", targetUser(home), entry);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, agentLinks: [managed] },
        }));
        const planInput = {
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [],
          namespaces: reconciliationNamespaces([namespaceResolution([])], [targetUser(home)]),
        };
        const plan = yield* planReconciliation({ ...planInput, managedLinks: [managed] });
        const stall = yield* stallAt("remove", destination, { when: "after" });
        const fiber = yield* provideTestFileSystem(
          applyReconciliationPlan(options, plan),
          stall.fileSystem,
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(stall.entered);
        expect(yield* fileSystem.exists(lockPath)).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
        expect((yield* readState(options)).data.journal?.map((prepared) => prepared._tag)).toEqual([
          "remove",
        ]);
        const persisted = JSON.parse(
          yield* fileSystem.readFileString(path.join(stateDirectory, "state.json")),
        );
        expect(persisted).toMatchObject({
          format: 1,
          data: { journal: [{ _tag: "remove" }] },
        });
        // The evidence stays recorded until the removal settles.
        expect(persisted.data.links).toHaveLength(1);

        const recovered = yield* replan(options, planInput);
        expect(recovered.units[0]?.status).toBe("success");
        expect(yield* fileSystem.exists(destination)).toBe(false);
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);
        expect((yield* readState(options)).data.journal).toBeUndefined();
      }),
    ),
  );

  applyIt.effect("recovers a prepared create before planning", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const destination = path.join(home, ".cursor", "skills", "skill");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const managed = evidence("cursor", targetUser(home), entry);
        const planInput = {
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [entry],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([entry.address])],
            [targetUser(home)],
          ),
        };
        const plan = yield* planReconciliation({ ...planInput, managedLinks: [] });
        const preparedAction = plan.units[0]?.actions[0];
        if (preparedAction === undefined) {
          throw new Error("Expected a link-create plan.");
        }
        yield* fileSystem.symlink(path.relative(path.dirname(destination), source), destination);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, preparedAgentAction: { action: preparedAction } },
        }));

        const result = yield* replan(options, planInput);

        expect(result.units[0]?.status).toBe("success");
        expect(result.units[0]?.actions).toEqual([]);
        expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([managed]);
        expect((yield* readState(options)).data.journal).toBeUndefined();
      }),
    ),
  );

  applyIt.effect("refuses to prepare a replacement over evidence that still owes a removal", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const oldSource = path.join(root, "source", "old");
        const newSource = path.join(root, "source", "new");
        const destination = path.join(home, ".cursor", "skills", "moving");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(oldSource, { recursive: true });
        yield* fileSystem.makeDirectory(newSource, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.symlink(path.relative(path.dirname(destination), oldSource), destination);
        yield* initializeState(options);
        const oldEntry = catalogEntry("moving", oldSource);
        const newEntry = catalogEntry("moving", newSource);
        const previous = evidence("cursor", targetUser(home), oldEntry);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            agentLinks: [previous],
            pendingRemovals: [{ cause: "root-removal", evidence: previous }],
          },
        }));
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [newEntry],
          managedLinks: [previous],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([newEntry.address])],
            [targetUser(home)],
          ),
        });
        const statePath = path.join(stateDirectory, "state.json");

        // The replacement is refused when the batch is prepared, because the retained removal still
        // names the previous evidence. Nothing has changed yet: the old link stays, managed.
        const error = yield* Effect.flip(applyReconciliationPlan(options, plan));

        expect(error).toBeInstanceOf(StateMutationError);
        expect(error.message).toContain("Prepared links must agree");
        const retained = yield* readState(options);
        expect(stateManagedLinks(retained)).toEqual([previous]);
        expect(statePendingRemovals(retained)).toEqual([
          { cause: "root-removal", evidence: previous },
        ]);
        expect(retained.data.journal).toBeUndefined();
        expect(yield* fileSystem.exists(destination)).toBe(true);
        const retainedBytes = yield* fileSystem.readFileString(statePath);
        expect(retainedBytes).not.toContain(newSource);
      }),
    ),
  );

  applyIt.effect("applies under the state writer lock", () =>
    withTemporaryRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(root, "state");
        const home = path.join(root, "home");
        const source = path.join(root, "source", "skill");
        const options = stateOptions(stateDirectory);
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(home, { recursive: true });
        yield* initializeState(options);
        const entry = catalogEntry("skill", source);
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [entry],
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [namespaceResolution([entry.address])],
            [targetUser(home)],
          ),
        });
        yield* expectWriterGuarded(stateDirectory, applyReconciliationPlan(options, plan));
        expect(yield* fileSystem.exists(path.join(home, ".cursor"))).toBe(false);
      }),
    ),
  );
});
