import { skillText } from "./support/source-tree.ts";
import { pendingRemovalsOf } from "../src/domain/links/link-record-schema.ts";
import { projectRecords } from "./support/state-fixture.ts";
import { allSkillChoices } from "../src/domain/state/state-intent.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { SyncPlanSchema } from "../src/domain/reconciliation/sync-schema.ts";
import { readState } from "../src/services/state-store.ts";
import {
  partialEnvelope,
  hostTack,
  successfulEnvelope,
  withTackWorld,
} from "./support/tack-world.ts";
import { decodeEnvelope, runGit } from "./support/tack-process.ts";

// Real Git, and Tack in process. The process-level smoke test is in
// `project-refresh.system.test.ts`.
it.layer(LiveTestLayer)("project refresh against real Git", (refreshIt) => {
  refreshIt.effect(
    "bare reconcile and clean leave other project and user links alone",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fixtureRoot = path.dirname(fixture.primaryRoot);
          const otherRoot = path.join(fixtureRoot, "other");
          yield* runGit(fixtureRoot, ["clone", path.join(fixtureRoot, "remote.git"), otherRoot]);
          successfulEnvelope(
            yield* hostTack(fixture, ["project", "add", "other", "--repository-cwd", otherRoot]),
          );
          // The user gets a skill of its own: a project leaves a skill the user links to that link.
          yield* fileSystem.makeDirectory(path.join(fixture.sourceDirectory, "skills", "personal"));
          yield* fileSystem.writeFileString(
            path.join(fixture.sourceDirectory, "skills", "personal", "SKILL.md"),
            skillText("personal", {
              description: "Personal skill",
              tack: ["activation: opt-in"],
              body: "",
            }),
          );
          successfulEnvelope(
            yield* hostTack(fixture, ["pick", "include", "valid", "--project", "other"]),
          );
          successfulEnvelope(yield* hostTack(fixture, ["pick", "include", "personal", "--user"]));
          successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "codex"]));
          const destination = (root: string, name = "valid") =>
            path.join(root, ".agents", "skills", name);
          const workspaceLink = destination(fixture.primaryRoot);
          const otherLink = destination(otherRoot);
          const userLink = destination(fixture.homeDirectory, "personal");

          const bare = successfulEnvelope(yield* hostTack(fixture, ["sync", "--apply"]));
          expect(bare.plan).toMatchObject({
            resources: {
              selection: {
                selector: { _tag: "bare" },
                containingRoot: { projectName: "workspace" },
              },
            },
          });
          expect(yield* fileSystem.exists(workspaceLink)).toBe(true);
          expect(yield* fileSystem.exists(otherLink)).toBe(false);
          expect(yield* fileSystem.exists(userLink)).toBe(false);

          successfulEnvelope(
            yield* hostTack(fixture, ["sync", "--all", "--apply"], fixture.homeDirectory),
          );
          expect(yield* fileSystem.exists(otherLink)).toBe(true);
          expect(yield* fileSystem.exists(userLink)).toBe(true);
          successfulEnvelope(yield* hostTack(fixture, ["state", "clean", "--apply"]));
          expect(yield* fileSystem.exists(workspaceLink)).toBe(false);
          expect(yield* fileSystem.exists(otherLink)).toBe(true);
          expect(yield* fileSystem.exists(userLink)).toBe(true);
        }),
      ),
    { timeout: 30_000 },
  );
  refreshIt.effect(
    "rejects bare maintenance and refresh outside registered projects without changing state",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const before = yield* fileSystem.readFileString(statePath);
          const destination = path.join(fixture.homeDirectory, "operator-sentinel");
          yield* fileSystem.writeFileString(destination, "operator data\n");
          for (const args of [
            ["sync"],
            ["sync", "--apply"],
            ["sync"],
            ["status"],
            ["state", "clean"],
            ["state", "clean", "--apply"],
            ["state", "clean", "--pending"],
            ["state", "clean", "--pending", "--apply"],
            ["project", "refresh"],
            ["project", "refresh", "--apply"],
          ]) {
            const result = yield* hostTack(fixture, args, fixture.homeDirectory);
            expect(result.exitCode, args.join(" ")).toBe(ChildProcessSpawner.ExitCode(2));
            expect(decodeEnvelope(result.stdout)).toMatchObject({
              classification: "invalid-configuration",
              diagnostics: [
                expect.objectContaining({ code: "bare-target-requires-registered-root" }),
              ],
            });
            expect(yield* fileSystem.readFileString(statePath)).toBe(before);
            expect(yield* fileSystem.readFileString(destination)).toBe("operator data\n");
          }
          for (const args of [
            ["sync", "--all"],
            ["sync", "--all"],
            ["status", "--all"],
            ["state", "clean", "--all"],
            ["state", "clean", "--pending", "--all"],
            ["state", "clean", "--pending", "--all", "--apply"],
          ]) {
            const result = yield* hostTack(fixture, args, fixture.homeDirectory);
            expect(result.exitCode, args.join(" ")).not.toBe(ChildProcessSpawner.ExitCode(2));
            const envelope = decodeEnvelope(result.stdout);
            const payload =
              args[0] === "status"
                ? envelope.result
                : args[0] === "sync"
                  ? Schema.decodeUnknownSync(SyncPlanSchema)(envelope.plan).resources
                  : envelope.plan;
            expect(payload).toMatchObject({ selection: { selector: { _tag: "all" } } });
          }
          const fromCwd = successfulEnvelope(
            yield* hostTack(
              fixture,
              ["project", "refresh", "--cwd", fixture.primaryRoot],
              fixture.homeDirectory,
            ),
          );
          expect(fromCwd.plan).toMatchObject({
            selection: { selector: { _tag: "bare" }, projectName: "workspace" },
          });
          const nestedRepo = path.join(fixture.primaryRoot, "unregistered");
          yield* runGit(fixture.primaryRoot, ["init", nestedRepo]);
          const fallback = successfulEnvelope(
            yield* hostTack(fixture, ["project", "refresh"], nestedRepo),
          );
          expect(fallback.plan).toMatchObject({
            refresh: { scope: { _tag: "project", projectName: "workspace" } },
            selection: {
              selector: { _tag: "bare" },
              projectName: "workspace",
              matchedBy: { _tag: "containing-root", root: fixture.primaryRoot },
            },
          });
        }),
      ),
    { timeout: 30_000 },
  );
  refreshIt.effect(
    "applies the exact dry-run plan for worktree additions and missing non-final roots",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* runGit(fixture.primaryRoot, [
            "worktree",
            "add",
            "-b",
            "feature",
            fixture.worktreeRoot,
          ]);
          const canonicalWorktree = yield* fileSystem.realPath(fixture.worktreeRoot);
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const beforeAdditionPlan = yield* fileSystem.readFileString(statePath);
          const additionPlan = successfulEnvelope(
            yield* hostTack(fixture, ["project", "refresh"], fixture.worktreeRoot),
          );
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeAdditionPlan);
          expect(additionPlan).toMatchObject({
            applied: null,
            command: "project refresh",
            plan: {
              kind: "project-refresh-command-plan",
              refresh: {
                projects: [{ additions: [canonicalWorktree], removals: [] }],
                scope: { _tag: "project", projectName: "workspace" },
              },
              selection: {
                selector: { _tag: "bare" },
                projectName: "workspace",
                matchedBy: { _tag: "git-directory" },
              },
              removals: [],
              version: 1,
            },
          });
          const added = successfulEnvelope(
            yield* hostTack(fixture, ["project", "refresh", "--apply"], fixture.worktreeRoot),
          );
          expect(added.plan).toEqual(additionPlan.plan);
          expect(added.applied).toMatchObject({
            refresh: {
              changes: [
                { action: "added", canonicalRoot: canonicalWorktree, projectName: "workspace" },
              ],
            },
            removals: [],
          });

          yield* runGit(fixture.primaryRoot, [
            "worktree",
            "remove",
            "--force",
            fixture.worktreeRoot,
          ]);
          const beforeRemovalPlan = yield* fileSystem.readFileString(statePath);
          const removalPlan = successfulEnvelope(
            yield* hostTack(fixture, ["project", "refresh", "--project", "workspace"]),
          );
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeRemovalPlan);
          expect(removalPlan.plan).toMatchObject({
            refresh: {
              projects: [
                {
                  additions: [],
                  removals: [
                    {
                      action: "deregister",
                      canonicalRoot: canonicalWorktree,
                      finalProject: false,
                      rootReachable: false,
                    },
                  ],
                },
              ],
            },
            removals: [],
          });
          const removed = successfulEnvelope(
            yield* hostTack(fixture, ["project", "refresh", "--project", "workspace", "--apply"]),
          );
          expect(removed.plan).toEqual(removalPlan.plan);
          const state = yield* readState(fixture.options);
          expect(projectRecords(state)).toEqual([
            {
              gitCommonDirectory: path.join(fixture.primaryRoot, ".git"),
              name: "workspace",
              roots: [fixture.primaryRoot],
            },
          ]);
          expect(allSkillChoices(state)).toEqual([
            expect.objectContaining({
              address: expect.objectContaining({ kind: "skill", name: "valid" }),
              decision: "include",
              namespace: { _tag: "project", projectName: "workspace" },
            }),
          ]);
        }),
      ),
    { timeout: 20_000 },
  );

  refreshIt.effect(
    "preserves a final-root conflict and its namespace for a later retry",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fixtureRoot = path.dirname(fixture.stateDirectory);
          const finalAnchor = path.join(fixtureRoot, "final.git");
          const finalRoot = path.join(fixtureRoot, "final-root");
          const foreignTarget = path.join(fixtureRoot, "foreign-skill");
          yield* fileSystem.makeDirectory(foreignTarget, { recursive: true });
          yield* runGit(fixtureRoot, ["init", "--bare", finalAnchor]);
          yield* runGit(fixture.primaryRoot, ["remote", "add", "final-fixture", finalAnchor]);
          yield* runGit(fixture.primaryRoot, ["push", "final-fixture", "HEAD:main"]);
          yield* runGit(fixtureRoot, [
            "--git-dir",
            finalAnchor,
            "worktree",
            "add",
            finalRoot,
            "main",
          ]);
          const canonicalFinalRoot = yield* fileSystem.realPath(finalRoot);
          successfulEnvelope(
            yield* hostTack(fixture, [
              "project",
              "add",
              "final-project",
              "--repository-cwd",
              canonicalFinalRoot,
            ]),
          );
          successfulEnvelope(
            yield* hostTack(fixture, ["pick", "include", "valid", "--project", "final-project"]),
          );
          successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "codex"]));
          successfulEnvelope(
            yield* hostTack(fixture, ["sync", "--project", "final-project", "--apply"]),
          );
          const destination = path.join(canonicalFinalRoot, ".agents", "skills", "valid");
          expect(yield* fileSystem.readLink(destination)).not.toMatch(/^\//);

          yield* runGit(fixtureRoot, [
            "--git-dir",
            finalAnchor,
            "worktree",
            "remove",
            "--force",
            finalRoot,
          ]);
          yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
          yield* fileSystem.symlink(
            path.relative(path.dirname(destination), foreignTarget),
            destination,
          );

          const statePath = path.join(fixture.stateDirectory, "state.json");
          const beforeDryRun = yield* fileSystem.readFileString(statePath);
          const dryRun = partialEnvelope(
            yield* hostTack(fixture, ["project", "refresh", "--project", "final-project"]),
          );
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeDryRun);
          expect(dryRun.plan).toMatchObject({
            kind: "project-refresh-command-plan",
            refresh: {
              projects: [
                {
                  removals: [
                    {
                      action: "handoff",
                      canonicalRoot: canonicalFinalRoot,
                      finalProject: true,
                      rootReachable: true,
                    },
                  ],
                },
              ],
            },
            removals: [
              {
                actions: [
                  {
                    _tag: "blocked",
                    destinationPath: destination,
                    observation: { _tag: "relative-link", canonicalTarget: foreignTarget },
                  },
                ],
                scope: {
                  _tag: "retry-targets",
                  targets: [
                    {
                      _tag: "project-root",
                      canonicalPath: canonicalFinalRoot,
                      projectName: "final-project",
                    },
                  ],
                },
              },
            ],
          });
          const applied = partialEnvelope(
            yield* hostTack(fixture, [
              "project",
              "refresh",
              "--project",
              "final-project",
              "--apply",
            ]),
          );
          expect(applied.plan).toEqual(dryRun.plan);
          expect(yield* fileSystem.readLink(destination)).toBe(
            path.relative(path.dirname(destination), foreignTarget),
          );
          const state = yield* readState(fixture.options);
          expect(state.data.projects).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: "final-project",
                removingRoots: [canonicalFinalRoot],
                roots: [],
              }),
            ]),
          );
          expect(allSkillChoices(state)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                namespace: { _tag: "project", projectName: "final-project" },
              }),
            ]),
          );
          expect(pendingRemovalsOf(state.data.links)).toEqual([
            expect.objectContaining({
              evidence: expect.objectContaining({
                target: {
                  _tag: "project-root",
                  canonicalPath: canonicalFinalRoot,
                  projectName: "final-project",
                },
              }),
            }),
          ]);
          const beforeStatus = yield* fileSystem.readFileString(statePath);
          const status = partialEnvelope(
            yield* hostTack(fixture, ["status", "--project", "final-project"]),
          );
          expect(status.result).toMatchObject({
            destinations: [
              {
                _tag: "drift",
                destinationPath: destination,
                pendingRemoval: { cause: "project-removal" },
              },
            ],
            namespaces: [
              {
                lifecycle: "suspended-removing",
                namespace: { _tag: "project", projectName: "final-project" },
              },
            ],
            pendingRemovals: [expect.objectContaining({ destinationPath: destination })],
            projects: [expect.objectContaining({ lifecycle: "removing", name: "final-project" })],
          });
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeStatus);

          yield* fileSystem.remove(destination);
          const retried = successfulEnvelope(
            yield* hostTack(fixture, [
              "state",
              "clean",
              "--pending",
              "--project",
              "final-project",
              "--apply",
            ]),
          );
          expect(retried.applied).toMatchObject({
            actions: [{ _tag: "applied" }],
            finalizedProject: true,
            pendingRemovals: [],
          });
          const converged = yield* readState(fixture.options);
          expect(converged.data.projects).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "final-project" })]),
          );
          expect(allSkillChoices(converged)).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                namespace: { _tag: "project", projectName: "final-project" },
              }),
            ]),
          );
        }),
      ),
    { timeout: 20_000 },
  );

  refreshIt.effect(
    "previews and applies every registered project with --all from any directory",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fixtureRoot = path.dirname(fixture.primaryRoot);
          const otherRoot = path.join(fixtureRoot, "other");
          yield* runGit(fixtureRoot, ["clone", path.join(fixtureRoot, "remote.git"), otherRoot]);
          successfulEnvelope(
            yield* hostTack(fixture, [
              "project",
              "add",
              "other",
              "--repository-cwd",
              yield* fileSystem.realPath(otherRoot),
            ]),
          );
          const nestedWorktree = path.join(otherRoot, "workspace-wt");
          yield* runGit(fixture.primaryRoot, [
            "worktree",
            "add",
            "-b",
            "scope-feature",
            nestedWorktree,
          ]);
          const bareNested = successfulEnvelope(
            yield* hostTack(fixture, ["project", "refresh"], nestedWorktree),
          );
          expect(bareNested.plan).toMatchObject({
            refresh: {
              scope: { _tag: "project", projectName: "workspace" },
              projects: [{ additions: [nestedWorktree], expectedProject: { name: "workspace" } }],
            },
            selection: {
              selector: { _tag: "bare" },
              projectName: "workspace",
              matchedBy: { _tag: "git-directory" },
            },
          });
          successfulEnvelope(
            yield* hostTack(fixture, ["project", "refresh", "--apply"], nestedWorktree),
          );
          expect(
            (yield* readState(fixture.options)).data.projects?.find(
              (project) => project.name === "other",
            )?.roots,
          ).toEqual([otherRoot]);
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const before = yield* fileSystem.readFileString(statePath);

          const preview = successfulEnvelope(
            yield* hostTack(fixture, ["project", "refresh", "--all"], fixture.homeDirectory),
          );
          expect(preview).toMatchObject({ command: "project refresh" });
          expect(preview.plan).toMatchObject({
            refresh: {
              projects: [
                { expectedProject: { name: "other" } },
                { expectedProject: { name: "workspace" } },
              ],
              scope: { _tag: "all" },
            },
          });
          expect(yield* fileSystem.readFileString(statePath)).toBe(before);

          const applied = successfulEnvelope(
            yield* hostTack(
              fixture,
              ["project", "refresh", "--all", "--apply"],
              fixture.homeDirectory,
            ),
          );
          expect(applied.plan).toEqual(preview.plan);
          expect(applied.applied).not.toBeNull();

          const explicit = successfulEnvelope(
            yield* hostTack(
              fixture,
              ["project", "refresh", "--project", "workspace"],
              fixture.homeDirectory,
            ),
          );
          expect(explicit.plan).toMatchObject({
            refresh: { scope: { _tag: "project", projectName: "workspace" } },
          });
        }),
      ),
    { timeout: 20_000 },
  );

  refreshIt.effect(
    "previews the docs a refresh mounts and reports a later docs conflict as partial",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fileSystem.makeDirectory(path.join(fixture.sourceDirectory, "knowledge"));
          yield* fileSystem.writeFileString(
            path.join(fixture.sourceDirectory, "tack.yaml"),
            "version: 1\nname: source\nskills:\n  - path: skills\ndocs:\n  - name: handbook\n    path: knowledge\n",
          );
          const sourceId = (yield* readState(fixture.options)).data.sources?.at(0)?.id ?? "";
          successfulEnvelope(
            yield* hostTack(fixture, [
              "docs",
              "attach",
              `${sourceId}:handbook`,
              "--project",
              "workspace",
            ]),
          );
          successfulEnvelope(
            yield* hostTack(fixture, [
              "sync",
              "--no-adapters",
              "--project",
              "workspace",
              "--apply",
            ]),
          );
          yield* runGit(fixture.primaryRoot, [
            "worktree",
            "add",
            "-b",
            "feature",
            fixture.worktreeRoot,
          ]);
          const canonicalWorktree = yield* fileSystem.realPath(fixture.worktreeRoot);
          const mount = path.join(canonicalWorktree, ".tack/docs", sourceId, "handbook");

          const preview = successfulEnvelope(
            yield* hostTack(fixture, ["project", "refresh", "--project", "workspace"]),
          );
          expect(preview.plan).toMatchObject({
            docs: {
              actions: [
                { action: "keep", evidence: { root: fixture.primaryRoot } },
                { action: "create", evidence: { root: canonicalWorktree } },
              ],
              complete: true,
            },
          });

          yield* fileSystem.makeDirectory(mount, { recursive: true });
          const applied = partialEnvelope(
            yield* hostTack(fixture, ["project", "refresh", "--project", "workspace", "--apply"]),
          );
          expect(applied.applied).toMatchObject({
            docs: {
              actions: [
                { _tag: "applied", action: { action: "keep" } },
                {
                  _tag: "blocked",
                  action: { action: "conflict", evidence: { root: canonicalWorktree } },
                },
              ],
              complete: false,
            },
            refresh: {
              changes: [
                { action: "added", canonicalRoot: canonicalWorktree, projectName: "workspace" },
              ],
            },
          });
          expect(applied.diagnostics).toMatchObject([{ code: "project-refresh-docs-partial" }]);
          expect(
            (yield* readState(fixture.options)).data.projects?.find(
              (project) => project.name === "workspace",
            )?.roots,
          ).toEqual([fixture.primaryRoot, canonicalWorktree]);
        }),
      ),
  );
});
