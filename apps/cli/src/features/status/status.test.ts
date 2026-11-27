import { bareSkillText } from "../../../test/support/source-tree.ts";
import {
  mutateStateFixture,
  withStateFixture,
  relativeLink,
} from "../../../test/support/state-fixture.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import { Destination } from "../../services/destination.ts";
import { registerSource } from "../sources/source.ts";
import { runStatus, statusPartialCauses } from "./status.ts";
import { StatusReportSchema } from "../../domain/status/status-schema.ts";
import { readState } from "../../services/state-store.ts";
import { makeDestinationService } from "../../platform/filesystem/destination-observation.ts";
import { statusOutcome, withOutsidePendingDiagnostic } from "../../cli/envelope/outcomes.ts";

const createSource = Effect.fnUntraced(function* (
  root: string,
  directoryName: string,
  skills: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = path.join(root, directoryName);
  yield* fileSystem.makeDirectory(source, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(source, "tack.yaml"),
    `version: 1\nname: ${directoryName}\nskills:\n  - path: skills\n`,
  );
  yield* Effect.forEach(skills, (name) => {
    const directory = path.join(source, "skills", name);
    return fileSystem
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.andThen(
          fileSystem.writeFileString(path.join(directory, "SKILL.md"), bareSkillText(name)),
        ),
      );
  });
  return source;
});

it.layer(LiveTestLayer)("read-only status", (statusIt) => {
  statusIt.effect(
    "reports desired, observed, unhealthy, quarantined, conflicting, and pending state without writes",
    () =>
      withStateFixture(({ options, root, statePath }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedSource = yield* createSource(root, "shared-source", [
            "alpha",
            "beta",
            "delta",
            "failed",
            "foreign",
            "gamma",
          ]);
          const privateSource = yield* createSource(root, "private-source", ["alpha"]);
          const missingSource = yield* createSource(root, "missing-source", []);
          const invalidDirectory = path.join(sharedSource, "skills", "invalid");
          yield* fileSystem.makeDirectory(invalidDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(invalidDirectory, "SKILL.md"),
            bareSkillText("different-name"),
          );
          yield* registerSource(options, { sourcePath: sharedSource });
          yield* registerSource(options, { sourcePath: privateSource });
          yield* registerSource(options, { sourcePath: missingSource });
          yield* fileSystem.remove(missingSource, { recursive: true });

          const projectRoot = path.join(root, "project-a");
          const otherRoot = path.join(root, "project-b");
          const anchor = path.join(root, "anchor-a");
          const otherAnchor = path.join(root, "anchor-b");
          const cwd = path.join(projectRoot, "packages", "app");
          yield* fileSystem.makeDirectory(cwd, { recursive: true });
          yield* fileSystem.makeDirectory(otherRoot, { recursive: true });
          yield* fileSystem.makeDirectory(anchor, { recursive: true });
          yield* fileSystem.makeDirectory(otherAnchor, { recursive: true });
          const canonicalProjectRoot = yield* fileSystem.realPath(projectRoot);
          const canonicalOtherRoot = yield* fileSystem.realPath(otherRoot);
          const canonicalAnchor = yield* fileSystem.realPath(anchor);
          const canonicalOtherAnchor = yield* fileSystem.realPath(otherAnchor);
          const registrations = (yield* readState(options)).data.sources ?? [];
          const sharedRegistration = registrations.find(
            (registration) => registration.canonicalPath === sharedSource,
          );
          if (sharedRegistration === undefined) {
            throw new Error("Expected the shared source registration.");
          }

          const evidenceFor = (name: string) => ({
            adapter: "codex" as const,
            address: { kind: "skill" as const, name, sourceRegistrationId: sharedRegistration.id },
            sourceDirectoryPath: path.join(sharedSource, "skills", name),
            sourceRegistrationId: sharedRegistration.id,
            target: {
              _tag: "project-root" as const,
              canonicalPath: canonicalProjectRoot,
              projectName: "project-a",
            },
          });
          const skillDirectory = path.join(canonicalProjectRoot, ".agents", "skills");
          const betaDestination = path.join(skillDirectory, "beta");
          const deltaDestination = path.join(skillDirectory, "delta");
          const foreignDestination = path.join(skillDirectory, "foreign");
          const pendingEvidence = evidenceFor("pending-old");
          const pendingDestination = managedLinkDestinationPath(pendingEvidence);
          yield* relativeLink(betaDestination, path.join(sharedSource, "skills", "beta"));
          yield* relativeLink(deltaDestination, path.join(sharedSource, "skills", "gamma"));
          yield* fileSystem.writeFileString(foreignDestination, "operator-owned\n");
          yield* fileSystem.writeFileString(pendingDestination, "replacement\n");

          const agentLinks = [evidenceFor("beta"), evidenceFor("delta"), evidenceFor("orphan")];
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              choices: [
                {
                  address: {
                    kind: "skill" as const,
                    name: "gamma",
                    sourceRegistrationId: sharedRegistration.id,
                  },
                  decision: "include" as const,
                  namespace: { _tag: "project" as const, projectName: "project-a" },
                },
                {
                  address: {
                    kind: "skill" as const,
                    name: "beta",
                    sourceRegistrationId: sharedRegistration.id,
                  },
                  decision: "include" as const,
                  namespace: { _tag: "project" as const, projectName: "project-a" },
                },
              ],
              enabledAdapters: ["codex"],
              agentLinks,
              pendingRemovals: [
                {
                  cause: "clean" as const,
                  evidence: pendingEvidence,
                  lastResult: { _tag: "blocked" as const, message: "replacement present" },
                },
              ],
              projects: [
                {
                  gitCommonDirectory: canonicalAnchor,
                  name: "project-a",
                  roots: [canonicalProjectRoot],
                },
                {
                  gitCommonDirectory: canonicalOtherAnchor,
                  name: "project-b",
                  roots: [canonicalOtherRoot],
                },
              ],
            },
          }));

          const encodedStateBefore = yield* fileSystem.readFileString(statePath);
          const skillBefore = yield* fileSystem.readFileString(
            path.join(sharedSource, "skills", "beta", "SKILL.md"),
          );
          const betaLinkBefore = yield* fileSystem.readLink(betaDestination);
          const deltaLinkBefore = yield* fileSystem.readLink(deltaDestination);
          const foreignBefore = yield* fileSystem.readFileString(foreignDestination);
          const pendingBefore = yield* fileSystem.readFileString(pendingDestination);
          const failedDestination = path.join(skillDirectory, "failed");
          const guardedFileSystem = {
            ...fileSystem,
            readLink: (candidate: string) =>
              candidate === failedDestination
                ? Effect.fail(
                    PlatformError.badArgument({ module: "status-test", method: "readLink" }),
                  )
                : fileSystem.readLink(candidate),
            stat: (candidate: string) =>
              candidate === failedDestination
                ? Effect.fail(PlatformError.badArgument({ module: "status-test", method: "stat" }))
                : fileSystem.stat(candidate),
          } satisfies FileSystem.FileSystem;

          const status = () =>
            runStatus(options, {
              cwd,
              selector: { _tag: "all" },
            }).pipe(
              Effect.provideService(Destination, makeDestinationService(guardedFileSystem, path)),
              Effect.provideService(FileSystem.FileSystem, guardedFileSystem),
            );
          const report = yield* status();
          const repeated = yield* status();

          expect(report).toEqual(repeated);
          expect(report.projects.map((project) => project.name)).toEqual([
            "project-a",
            "project-b",
          ]);
          expect(report.sources.map((source) => source.status)).toEqual([
            "unhealthy",
            "healthy",
            "healthy",
          ]);
          expect(report.catalog).toMatchObject({ complete: false, kind: "catalog" });
          expect(report.catalog.issues.map((issue) => [issue.subject._tag, issue.code])).toEqual([
            ["source", "source-missing"],
            ["resource", "skill-name-mismatch"],
          ]);
          expect(report.catalog.resources.every((resource) => !("frontmatter" in resource))).toBe(
            true,
          );
          expect(report.scope).toEqual({ _tag: "all" });
          expect(report.selection.selector).toEqual({ _tag: "all" });
          expect(report.namespaces.map((namespace) => namespace.namespace)).toEqual([
            { _tag: "project", projectName: "project-a" },
            { _tag: "project", projectName: "project-b" },
            { _tag: "user" },
          ]);
          expect(
            report.destinations
              .filter((destination) => destination.destinationPath.startsWith(skillDirectory))
              .map((destination) => destination._tag),
          ).toEqual([
            "selection-conflict",
            "matching",
            "drift",
            "observation-failed",
            "hand-made",
            "expected-absent",
            "evidence-absent",
            "drift",
          ]);
          expect(report.pendingRemovals).toMatchObject([
            {
              cause: "clean",
              destinationPath: pendingDestination,
              lastResult: { _tag: "blocked", message: "replacement present" },
            },
          ]);
          const projectB = yield* runStatus(options, {
            cwd: canonicalProjectRoot,
            selector: { _tag: "project", projectName: "project-b" },
          });
          const bareProjectA = yield* runStatus(options, {
            cwd: canonicalProjectRoot,
            selector: { _tag: "bare" },
          });
          const namedProjectA = yield* runStatus(options, {
            cwd: canonicalProjectRoot,
            selector: { _tag: "project", projectName: "project-a" },
          });
          const { selection: bareEcho, ...bareFacts } = bareProjectA;
          const { selection: namedEcho, ...namedFacts } = namedProjectA;
          expect(bareEcho.containingRoot).toEqual({
            projectName: "project-a",
            root: canonicalProjectRoot,
          });
          expect(namedEcho.selector).toEqual({ _tag: "project", projectName: "project-a" });
          expect(bareFacts).toEqual(namedFacts);
          const baseOutcome = statusOutcome(projectB);
          const scopedOutcome = withOutsidePendingDiagnostic(
            baseOutcome,
            yield* readState(options),
            projectB.selection,
          );
          expect(scopedOutcome.classification).toBe(baseOutcome.classification);
          expect(scopedOutcome.diagnostics).toContainEqual(
            expect.objectContaining({
              code: "pending-removals-outside-scope",
              severity: "info",
              details: { count: 1, owners: ["project-a"] },
            }),
          );
          expect(
            Schema.decodeUnknownSync(StatusReportSchema, { onExcessProperty: "error" })(report),
          ).toEqual(report);
          expect(() =>
            Schema.decodeUnknownSync(StatusReportSchema, { onExcessProperty: "error" })({
              ...report,
              unsupported: true,
            }),
          ).toThrow();
          const expectedAbsent = report.destinations.find(
            (destination) => destination._tag === "expected-absent",
          );
          expect(expectedAbsent?.targetHealth).toBe("healthy");
          expect(() =>
            Schema.decodeUnknownSync(StatusReportSchema)({
              ...report,
              destinations: [...report.destinations].reverse(),
            }),
          ).toThrow();
          const projectNamespace = report.namespaces.find(
            (namespace) => namespace.namespace._tag === "project" && namespace.choices.length > 1,
          );
          if (projectNamespace === undefined) {
            throw new Error("Expected the project namespace choices.");
          }
          expect(() =>
            Schema.decodeUnknownSync(StatusReportSchema)({
              ...report,
              namespaces: report.namespaces.map((namespace) =>
                namespace === projectNamespace
                  ? { ...namespace, choices: [...namespace.choices].reverse() }
                  : namespace,
              ),
            }),
          ).toThrow();
          expect(
            report.destinations.find((destination) => destination.pendingRemoval !== undefined),
          ).toMatchObject({ _tag: "drift", evidence: pendingEvidence });
          // Selection decisions name catalog resources by address instead of repeating them.
          expect(projectNamespace.selection.decisions).toContainEqual({
            _tag: "selected",
            address: { kind: "skill", name: "gamma", sourceRegistrationId: sharedRegistration.id },
            compatibility: "compatible",
            reason: "include",
          });
          expect(
            new Set(
              report.namespaces.flatMap((namespace) =>
                namespace.selection.decisions.map((decision) =>
                  Object.keys(decision).sort().join(),
                ),
              ),
            ),
          ).toEqual(new Set(["_tag,address,compatibility,reason"]));

          expect(yield* fileSystem.readFileString(statePath)).toBe(encodedStateBefore);
          expect(
            yield* fileSystem.readFileString(path.join(sharedSource, "skills", "beta", "SKILL.md")),
          ).toBe(skillBefore);
          expect(yield* fileSystem.readLink(betaDestination)).toBe(betaLinkBefore);
          expect(yield* fileSystem.readLink(deltaDestination)).toBe(deltaLinkBefore);
          expect(yield* fileSystem.readFileString(foreignDestination)).toBe(foreignBefore);
          expect(yield* fileSystem.readFileString(pendingDestination)).toBe(pendingBefore);
        }),
      ),
  );

  statusIt.effect(
    "reports removing namespaces and retained roots without making them desired",
    () =>
      withStateFixture(({ options, root, statePath }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const anchor = path.join(root, "anchor");
          const retainedRoot = path.join(root, "retained-root");
          const missingRoot = path.join(root, "missing-root");
          yield* fileSystem.makeDirectory(anchor, { recursive: true });
          yield* fileSystem.makeDirectory(retainedRoot, { recursive: true });
          const retainedSource = path.join(root, "retained-source");
          yield* fileSystem.makeDirectory(retainedSource, { recursive: true });
          const canonicalAnchor = yield* fileSystem.realPath(anchor);
          const canonicalRetainedRoot = yield* fileSystem.realPath(retainedRoot);
          const canonicalRetainedSource = yield* fileSystem.realPath(retainedSource);
          const normalizedMissingRoot = path.resolve(missingRoot);
          const removingRoots = [canonicalRetainedRoot, normalizedMissingRoot].sort();
          const retainedEvidence = {
            adapter: "codex" as const,
            address: {
              kind: "skill" as const,
              name: "retained",
              sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
            },
            sourceDirectoryPath: canonicalRetainedSource,
            sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
            target: {
              _tag: "project-root" as const,
              canonicalPath: canonicalRetainedRoot,
              projectName: "retiring",
            },
          };
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              enabledAdapters: ["cursor"],
              agentLinks: [retainedEvidence],
              projects: [
                {
                  gitCommonDirectory: canonicalAnchor,
                  name: "retiring",
                  removingRoots,
                  roots: [],
                },
              ],
            },
          }));
          const before = yield* fileSystem.readFileString(statePath);

          const report = yield* runStatus(options, {
            cwd: root,
            selector: { _tag: "project", projectName: "retiring" },
          });

          expect(report.projects).toMatchObject([
            {
              lifecycle: "removing",
              name: "retiring",
              roots: [
                { lifecycle: "removing", path: removingRoots[0] },
                { lifecycle: "removing", path: removingRoots[1] },
              ],
            },
          ]);
          expect(report.projects[0]?.roots.map((rootStatus) => rootStatus.health)).toEqual(
            removingRoots.map((rootPath) =>
              rootPath === canonicalRetainedRoot ? "healthy" : "missing",
            ),
          );
          expect(report.namespaces).toMatchObject([
            {
              desired: [],
              lifecycle: "suspended-removing",
              namespace: { _tag: "project", projectName: "retiring" },
            },
          ]);
          expect(report.destinations).toMatchObject([
            {
              _tag: "evidence-absent",
              adapter: "codex",
              desired: [],
              destinationPath: managedLinkDestinationPath(retainedEvidence),
            },
          ]);
          expect(yield* fileSystem.readFileString(statePath)).toBe(before);
        }),
      ),
  );

  statusIt.effect("reports removing roots with the shared project root-health codes", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const anchor = path.join(root, "anchor");
        const realRoot = path.join(root, "real-root");
        const movedRoot = path.join(root, "moved-root");
        const fileRoot = path.join(root, "file-root");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        yield* fileSystem.makeDirectory(realRoot, { recursive: true });
        yield* fileSystem.symlink(realRoot, movedRoot);
        yield* fileSystem.writeFileString(fileRoot, "not a root\n");
        const removingRoots = [fileRoot, movedRoot, path.join(root, "missing-root")].sort();
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              {
                gitCommonDirectory: anchor,
                name: "retiring",
                removingRoots,
                roots: [],
              },
            ],
          },
        }));

        const report = yield* runStatus(options, {
          cwd: root,
          selector: { _tag: "project", projectName: "retiring" },
        });

        expect(
          report.projects[0]?.roots.map((rootStatus) => [
            path.basename(rootStatus.path),
            rootStatus.lifecycle,
            rootStatus.health,
            rootStatus.issue?.code,
          ]),
        ).toEqual([
          ["file-root", "removing", "unhealthy", "root-not-directory"],
          ["missing-root", "removing", "missing", "root-missing"],
          ["moved-root", "removing", "unhealthy", "root-location-changed"],
        ]);
      }),
    ),
  );

  statusIt.effect("reports only the user namespace for an explicit user selector", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const source = yield* createSource(root, "source", ["alpha"]);
        yield* registerSource(options, { sourcePath: source });
        const report = yield* runStatus(options, {
          cwd: root,
          selector: { _tag: "user" },
        });

        expect(report.projects).toEqual([]);
        expect(report.namespaces).toMatchObject([
          { lifecycle: "active", namespace: { _tag: "user" } },
        ]);
        expect(report.destinations).toEqual([]);
        expect(yield* fileSystem.exists(path.join(options.homeDirectory, ".agents"))).toBe(false);
      }),
    ),
  );

  statusIt.effect("derives one report from exactly one persisted state snapshot", () =>
    withStateFixture(({ options, root, statePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        let stateReads = 0;
        const countingFileSystem = FileSystem.makeNoop({
          ...fileSystem,
          readFileString: (candidate, encoding) => {
            if (candidate === statePath) {
              stateReads += 1;
            }
            return fileSystem.readFileString(candidate, encoding);
          },
        });

        const report = yield* provideTestFileSystem(
          runStatus(options, {
            cwd: root,
            selector: { _tag: "user" },
          }),
          countingFileSystem,
        );

        expect(report.kind).toBe("skill-status");
        expect(stateReads).toBe(1);
      }),
    ),
  );

  statusIt.effect("reports bad roots on their project and plans no desired links there", () =>
    withStateFixture(({ options, root, statePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const source = yield* createSource(root, "source", ["alpha"]);
        const { registration } = yield* registerSource(options, { sourcePath: source });
        const missingAnchor = path.join(root, "missing-anchor");
        const missingRoot = path.join(root, "missing-root");
        const fileRoot = path.join(root, "root-file");
        yield* fileSystem.writeFileString(fileRoot, "not a project directory\n");
        const canonicalFileRoot = yield* fileSystem.realPath(fileRoot);
        const projectRoots = [canonicalFileRoot, missingRoot].sort();
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            enabledAdapters: ["codex"],
            projects: [
              {
                gitCommonDirectory: missingAnchor,
                name: "missing-project",
                roots: projectRoots,
              },
            ],
            // A link recorded under each root before it went bad.
            agentLinks: projectRoots.map((canonicalPath) => ({
              adapter: "codex" as const,
              address: {
                kind: "skill" as const,
                name: "alpha",
                sourceRegistrationId: registration.id,
              },
              sourceDirectoryPath: path.join(source, "skills", "alpha"),
              sourceRegistrationId: registration.id,
              target: {
                _tag: "project-root" as const,
                canonicalPath,
                projectName: "missing-project",
              },
            })),
          },
        }));
        const before = yield* fileSystem.readFileString(statePath);

        const report = yield* runStatus(options, {
          cwd: root,
          selector: { _tag: "project", projectName: "missing-project" },
        });

        expect(report.projects).toMatchObject([
          {
            anchor: {
              issue: { code: "anchor-missing" },
              path: missingAnchor,
              status: "unhealthy",
            },
            roots: [
              {
                lifecycle: "active",
                path: projectRoots[0],
              },
              {
                lifecycle: "active",
                path: projectRoots[1],
              },
            ],
          },
        ]);
        expect(report.projects[0]?.roots.map((rootStatus) => rootStatus.health)).toEqual(
          projectRoots.map((rootPath) => (rootPath === missingRoot ? "missing" : "unhealthy")),
        );
        // Sync never targets a missing or unhealthy root, so nothing is desired there: only the
        // recorded links are listed, as retained evidence with the health of their target.
        expect(
          report.destinations.map((destination) => [
            destination.destinationPath,
            destination._tag,
            destination.desired,
            destination.targetHealth,
          ]),
        ).toEqual(
          projectRoots.map((rootPath) => [
            path.join(rootPath, ".agents", "skills", "alpha"),
            rootPath === missingRoot ? "target-missing" : "observation-failed",
            [],
            rootPath === missingRoot ? "missing" : "unhealthy",
          ]),
        );
        expect(statusPartialCauses(report).map((cause) => cause.code)).toEqual(
          expect.arrayContaining(["root-missing", "root-unhealthy"]),
        );
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
      }),
    ),
  );
});
