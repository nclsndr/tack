import { managedLinksOf } from "../../domain/links/link-record-schema.ts";
import { mutateStateFixture } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { applyReconciliationPlan } from "../../../test/support/reconciliation.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { agentAdapterDescriptor } from "../../domain/agents/agent-adapter.ts";
import type { ManagedLinkEvidence } from "../../domain/links/managed-link-schema.ts";
import type { SkillCatalogEntry } from "../../domain/sources/catalog-schema.ts";
import {
  initializeState,
  readState,
  withStateCheckpointWriter,
  type StateOptions,
} from "../../services/state-store.ts";
import { applyReconciliationWithWriter } from "./reconciliation-application.test-support.ts";
import { planReconciliation, reconciliationNamespaces } from "./reconciliation.ts";

const registrationId = "00000000-0000-4000-8000-000000000001";

/**
 * A user home, one skill source and the plan that links the skill into Cursor's user skills. Each
 * test changes the disk after planning, the way another process can, and then applies the plan.
 */
const staleWorld = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-stale-" }));
  const home = path.join(root, "home");
  const source = path.join(root, "source", "skill");
  const options = {
    environment: { TACK_STATE_DIR: path.join(root, "state") },
    homeDirectory: home,
  } satisfies StateOptions;
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.makeDirectory(home, { recursive: true });
  yield* initializeState(options);
  const entry = {
    activation: "default",
    address: { kind: "skill", name: "skill", sourceRegistrationId: registrationId },
    dependencies: [],
    description: "skill description",
    directoryPath: source,
    frontmatter: { description: "skill description", name: "skill" },
    projects: [],
    skillFilePath: `${source}/SKILL.md`,
    sourcePath: path.join(root, "source"),
    sourceRegistrationId: registrationId,
  } satisfies SkillCatalogEntry;
  const target = { _tag: "user", canonicalPath: home } as const;
  const evidence = {
    adapter: "cursor",
    address: entry.address,
    sourceDirectoryPath: source,
    sourceRegistrationId: registrationId,
    target,
  } satisfies ManagedLinkEvidence;
  const plan = (selected: boolean, managedLinks: ReadonlyArray<ManagedLinkEvidence> = []) =>
    planReconciliation({
      adapters: [agentAdapterDescriptor("cursor")],
      catalogEntries: [entry],
      managedLinks,
      namespaces: reconciliationNamespaces(
        [
          {
            namespace: { _tag: "user" },
            resolution: {
              groups: selected ? [{ _tag: "selected", members: [entry.address] }] : [],
              optionalSkips: [],
              requestBlockers: [],
            },
          },
        ],
        [target],
      ),
    });
  const skills = path.join(home, ".cursor", "skills");
  return {
    fs,
    path,
    root,
    home,
    source,
    options,
    evidence,
    plan,
    skills,
    destination: path.join(skills, "skill"),
  };
});

const outcomesOf = (result: Effect.Success<ReturnType<typeof applyReconciliationPlan>>) =>
  result.units.flatMap((unit) =>
    unit.actions.map((outcome) => [
      outcome.action._tag,
      outcome._tag,
      outcome._tag === "failed" ? outcome.code : undefined,
    ]),
  );

it.layer(LiveTestLayer)("applying a plan the disk moved past", (test) => {
  test.effect("accepts a resource directory another process created after planning", () =>
    Effect.gen(function* () {
      const { fs, options, plan, skills, destination, source } = yield* staleWorld;
      const planned = yield* plan(true);
      yield* fs.makeDirectory(skills, { recursive: true });
      const result = yield* applyReconciliationPlan(options, planned);
      expect(outcomesOf(result)).toEqual([
        ["directory-create", "applied", undefined],
        ["link-create", "applied", undefined],
      ]);
      expect(yield* fs.realPath(destination)).toBe(source);
    }),
  );

  test.effect("fails a resource directory that a successful create did not leave behind", () =>
    Effect.gen(function* () {
      const { fs, options, plan, skills } = yield* staleWorld;
      const planned = yield* plan(true);
      // The filesystem reports success without creating anything, so verification decides.
      const result = yield* provideTestFileSystem(applyReconciliationPlan(options, planned), {
        ...fs,
        makeDirectory: (directory, directoryOptions) =>
          directory === skills ? Effect.void : fs.makeDirectory(directory, directoryOptions),
      });
      expect(outcomesOf(result)).toEqual([
        ["directory-create", "failed", "destination-conflict"],
        ["link-create", "skipped", undefined],
      ]);
      expect(yield* fs.exists(skills)).toBe(false);
    }),
  );

  test.effect("fails a resource directory that is now a file and skips its links", () =>
    Effect.gen(function* () {
      const { fs, path, options, plan, skills } = yield* staleWorld;
      const planned = yield* plan(true);
      yield* fs.makeDirectory(path.dirname(skills), { recursive: true });
      yield* fs.writeFileString(skills, "a file\n");
      const result = yield* applyReconciliationPlan(options, planned);
      expect(outcomesOf(result)).toEqual([
        ["directory-create", "failed", "destination-conflict"],
        ["link-create", "skipped", undefined],
      ]);
      expect(result.units[0]?.status).toBe("failed");
    }),
  );

  test.effect("refuses to link a source that moved, changed type or is no longer canonical", () =>
    Effect.gen(function* () {
      const { fs, path, root, options, plan, skills, source } = yield* staleWorld;
      yield* fs.makeDirectory(skills, { recursive: true });
      const planned = yield* plan(true);
      const failure = () =>
        applyReconciliationPlan(options, planned).pipe(
          Effect.map((result) => result.units[0]?.actions[0]),
        );

      yield* fs.remove(source, { recursive: true });
      expect(yield* failure()).toMatchObject({ _tag: "failed", code: "filesystem-failure" });

      yield* fs.writeFileString(source, "not a directory\n");
      expect(yield* failure()).toMatchObject({
        _tag: "failed",
        code: "destination-conflict",
        message: "The recorded skill source must be a directory.",
        path: source,
      });

      yield* fs.remove(source);
      const moved = path.join(root, "moved");
      yield* fs.makeDirectory(moved);
      yield* fs.symlink(moved, source);
      expect(yield* failure()).toMatchObject({
        _tag: "failed",
        code: "destination-conflict",
        message: "The recorded source path is no longer canonical.",
        path: source,
      });
      expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);
    }),
  );

  test.effect("leaves an entry that appeared at the destination after planning", () =>
    Effect.gen(function* () {
      const { fs, options, plan, skills, destination } = yield* staleWorld;
      yield* fs.makeDirectory(skills, { recursive: true });
      const planned = yield* plan(true);
      yield* fs.writeFileString(destination, "operator-owned\n");
      const result = yield* applyReconciliationPlan(options, planned);
      expect(outcomesOf(result)).toEqual([["link-create", "failed", "destination-conflict"]]);
      expect(yield* fs.readFileString(destination)).toBe("operator-owned\n");
    }),
  );

  test.effect("adopts an unrecorded link only while it is still exactly Tack's", () =>
    Effect.gen(function* () {
      const { fs, path, root, options, plan, skills, source, destination, evidence } =
        yield* staleWorld;
      yield* fs.makeDirectory(skills, { recursive: true });
      yield* fs.symlink(path.relative(skills, source), destination);
      const planned = yield* plan(true);
      expect(planned.units[0]?.actions.map((action) => action._tag)).toEqual(["link-adopt"]);

      // Another process points the link elsewhere after the preview: nothing is recorded.
      yield* fs.remove(destination);
      yield* fs.symlink(path.relative(skills, root), destination);
      expect(outcomesOf(yield* applyReconciliationPlan(options, planned))).toEqual([
        ["link-adopt", "failed", "destination-conflict"],
      ]);
      expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);

      yield* fs.remove(destination);
      yield* fs.symlink(path.relative(skills, source), destination);
      expect(outcomesOf(yield* applyReconciliationPlan(options, planned))).toEqual([
        ["link-adopt", "applied", undefined],
      ]);
      expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([evidence]);
      expect(yield* fs.readLink(destination)).toBe(path.relative(skills, source));
    }),
  );

  test.effect("skips a destination an interrupted apply left prepared", () =>
    Effect.gen(function* () {
      const { fs, options, plan, skills, destination, evidence } = yield* staleWorld;
      yield* fs.makeDirectory(skills, { recursive: true });
      const planned = yield* plan(true);
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          reconciliationJournal: { action: { _tag: "link-create", evidence } },
        },
      }));
      // Applying without recovering first: the prepared destination is left for recovery.
      const result = yield* withStateCheckpointWriter(options, (writer) =>
        applyReconciliationWithWriter(writer, planned),
      );
      expect(result.units[0]?.actions).toMatchObject([
        {
          _tag: "skipped",
          reason: "An interrupted change to this destination is awaiting recovery.",
        },
      ]);
      expect(yield* fs.exists(destination)).toBe(false);
    }),
  );
});
