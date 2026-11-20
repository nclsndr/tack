import { pendingRemovalsOf } from "../src/domain/links/link-record-schema.ts";
import { managedDocsLinksOf } from "../src/domain/docs/docs-schema.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { readState } from "../src/services/state-store.ts";
import { managedLinkDestinationPath } from "../src/domain/agents/agent-layout.ts";
import {
  partialEnvelope,
  runGit,
  runTack,
  successfulEnvelope,
  withTackWorld,
  type TackWorld,
} from "./fixtures/tack-world.ts";

/** Attaches one docs resource to the fixture project and mounts it with a real reconcile. */
const mountDocs = Effect.fnUntraced(function* (fixture: TackWorld) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.join(fixture.sourceDirectory, "knowledge"));
  yield* fileSystem.writeFileString(
    path.join(fixture.sourceDirectory, "tack.yaml"),
    "version: 1\nskills:\n  - path: skills\ndocs:\n  - name: handbook\n    path: knowledge\n",
  );
  const sourceId = (yield* readState(fixture.options)).data.sources?.at(0)?.id ?? "";
  successfulEnvelope(yield* runTack(fixture, ["adapter", "enable", "codex"]));
  successfulEnvelope(
    yield* runTack(fixture, ["docs", "attach", `${sourceId}:handbook`, "--project", "workspace"]),
  );
  successfulEnvelope(
    yield* runTack(fixture, ["sync", "--no-adapters", "--project", "workspace", "--apply"]),
  );
  successfulEnvelope(yield* runTack(fixture, ["sync", "--project", "workspace", "--apply"]));
  return {
    mountFor: (root: string) => path.join(root, ".tack/docs", sourceId, "handbook"),
    skillFor: (root: string) => path.join(root, ".agents", "skills", "valid"),
  };
});

const docsLinkRoots = (links: ReadonlyArray<{ readonly root: string }>) =>
  links.map((link) => link.root);

const PlanDocsSchema = Schema.Struct({
  docsActions: Schema.optional(
    Schema.Array(Schema.Struct({ evidence: Schema.Struct({ root: Schema.String }) })),
  ),
});
/** Reads the docs mounts a removal plan says it will settle. */
const planDocsRoots = (plan: unknown) =>
  docsLinkRoots(
    (Schema.decodeUnknownSync(PlanDocsSchema)(plan).docsActions ?? []).map(
      (action) => action.evidence,
    ),
  );

it.layer(LiveTestLayer)("retry settles only obligations", (retryIt) => {
  retryIt.effect(
    "keeps a healthy docs mount and skill link when nothing is pending",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { mountFor, skillFor } = yield* mountDocs(fixture);
          const mount = mountFor(fixture.primaryRoot);
          const skill = skillFor(fixture.primaryRoot);
          expect(yield* fileSystem.exists(mount)).toBe(true);
          expect(yield* fileSystem.exists(skill)).toBe(true);
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const stateBefore = yield* fileSystem.readFileString(statePath);

          const preview = successfulEnvelope(
            yield* runTack(fixture, ["state", "clean", "--pending", "--project", "workspace"]),
          );
          expect(yield* fileSystem.readFileString(statePath)).toBe(stateBefore);
          const applied = successfulEnvelope(
            yield* runTack(fixture, [
              "state",
              "clean",
              "--pending",
              "--project",
              "workspace",
              "--apply",
            ]),
          );

          expect(yield* fileSystem.exists(mount)).toBe(true);
          expect(yield* fileSystem.exists(skill)).toBe(true);
          expect(yield* fileSystem.readFileString(statePath)).toBe(stateBefore);
          expect(preview.plan).toMatchObject({ actions: [] });
          expect(preview.plan).not.toHaveProperty("docsActions");
          expect(applied.plan).toEqual(preview.plan);
          expect(applied.applied).toMatchObject({ actions: [] });
          expect(applied.applied).not.toHaveProperty("docsActions");
          successfulEnvelope(yield* runTack(fixture, ["docs", "target", "--project", "workspace"]));
        }),
      ),
    { timeout: 40_000 },
  );

  retryIt.effect(
    "settles a removing root without touching the healthy mount on an active root",
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
          const worktree = yield* fileSystem.realPath(fixture.worktreeRoot);
          successfulEnvelope(
            yield* runTack(fixture, ["project", "refresh", "--project", "workspace", "--apply"]),
          );
          const { mountFor, skillFor } = yield* mountDocs(fixture);
          const primaryMount = mountFor(fixture.primaryRoot);
          const worktreeMount = mountFor(worktree);
          const worktreeSkill = skillFor(worktree);
          expect(yield* fileSystem.exists(primaryMount)).toBe(true);
          expect(yield* fileSystem.exists(worktreeMount)).toBe(true);
          expect(yield* fileSystem.exists(worktreeSkill)).toBe(true);

          // The worktree's Git record goes away, and the skill link and the mount drift.
          yield* runGit(fixture.primaryRoot, [
            "worktree",
            "remove",
            "--force",
            fixture.worktreeRoot,
          ]);
          const foreign = path.join(fixture.homeDirectory, "foreign");
          yield* fileSystem.makeDirectory(foreign, { recursive: true });
          for (const destination of [worktreeSkill, worktreeMount]) {
            yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
            yield* fileSystem.symlink(
              path.relative(path.dirname(destination), foreign),
              destination,
            );
          }
          partialEnvelope(
            yield* runTack(fixture, ["project", "refresh", "--project", "workspace", "--apply"]),
          );
          const retained = yield* readState(fixture.options);
          const project = retained.data.projects?.find((entry) => entry.name === "workspace");
          expect(project?.removingRoots).toEqual([worktree]);
          expect(
            pendingRemovalsOf(retained.data.links).map((entry) =>
              managedLinkDestinationPath(entry.evidence),
            ),
          ).toEqual([worktreeSkill]);

          const blockedPreview = partialEnvelope(
            yield* runTack(fixture, ["state", "clean", "--pending", "--project", "workspace"]),
          );
          expect(planDocsRoots(blockedPreview.plan)).toEqual([worktree]);

          // Clear the blockers, then retry settles the removing root.
          yield* fileSystem.remove(worktreeSkill);
          yield* fileSystem.remove(worktreeMount);
          const preview = successfulEnvelope(
            yield* runTack(fixture, ["state", "clean", "--pending", "--project", "workspace"]),
          );
          const applied = successfulEnvelope(
            yield* runTack(fixture, [
              "state",
              "clean",
              "--pending",
              "--project",
              "workspace",
              "--apply",
            ]),
          );
          expect(applied.plan).toEqual(preview.plan);
          expect(planDocsRoots(preview.plan)).not.toContain(fixture.primaryRoot);
          expect(yield* fileSystem.exists(primaryMount)).toBe(true);
          expect(yield* fileSystem.exists(skillFor(fixture.primaryRoot))).toBe(true);
          const settled = yield* readState(fixture.options);
          expect(
            settled.data.projects.find((entry) => entry.name === "workspace")?.removingRoots,
          ).toEqual([]);
          expect(pendingRemovalsOf(settled.data.links)).toEqual([]);
          expect(docsLinkRoots(managedDocsLinksOf(settled.data.links))).toEqual([
            fixture.primaryRoot,
          ]);
          successfulEnvelope(yield* runTack(fixture, ["docs", "target", "--project", "workspace"]));
        }),
      ),
    { timeout: 60_000 },
  );

  retryIt.effect(
    "still finalizes a project being removed, including its docs evidence",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { mountFor, skillFor } = yield* mountDocs(fixture);
          const fixtureRoot = path.dirname(fixture.stateDirectory);
          const finalAnchor = path.join(fixtureRoot, "final.git");
          const finalRoot = path.join(fixtureRoot, "final-root");
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
          const sourceId = (yield* readState(fixture.options)).data.sources?.at(0)?.id ?? "";
          successfulEnvelope(
            yield* runTack(fixture, [
              "project",
              "add",
              "final-project",
              "--repository-cwd",
              canonicalFinalRoot,
            ]),
          );
          successfulEnvelope(
            yield* runTack(fixture, ["pick", "include", "valid", "--project", "final-project"]),
          );
          successfulEnvelope(
            yield* runTack(fixture, [
              "docs",
              "attach",
              `${sourceId}:handbook`,
              "--project",
              "final-project",
            ]),
          );
          successfulEnvelope(
            yield* runTack(fixture, [
              "sync",
              "--no-adapters",
              "--project",
              "final-project",
              "--apply",
            ]),
          );
          successfulEnvelope(
            yield* runTack(fixture, ["sync", "--project", "final-project", "--apply"]),
          );
          const skill = skillFor(canonicalFinalRoot);
          expect(yield* fileSystem.exists(mountFor(canonicalFinalRoot))).toBe(true);

          yield* runGit(fixtureRoot, [
            "--git-dir",
            finalAnchor,
            "worktree",
            "remove",
            "--force",
            finalRoot,
          ]);
          const foreign = path.join(fixture.homeDirectory, "foreign");
          yield* fileSystem.makeDirectory(foreign, { recursive: true });
          yield* fileSystem.makeDirectory(path.dirname(skill), { recursive: true });
          yield* fileSystem.symlink(path.relative(path.dirname(skill), foreign), skill);
          partialEnvelope(
            yield* runTack(fixture, [
              "project",
              "refresh",
              "--project",
              "final-project",
              "--apply",
            ]),
          );
          const retained = yield* readState(fixture.options);
          expect(
            retained.data.projects?.find((entry) => entry.name === "final-project"),
          ).toMatchObject({ removingRoots: [canonicalFinalRoot], roots: [] });

          yield* fileSystem.remove(skill);
          const retried = successfulEnvelope(
            yield* runTack(fixture, [
              "state",
              "clean",
              "--pending",
              "--project",
              "final-project",
              "--apply",
            ]),
          );
          expect(retried.applied).toMatchObject({ finalizedProject: true, pending: [] });
          const settled = yield* readState(fixture.options);
          expect(settled.data.projects?.map((entry) => entry.name)).toEqual(["workspace"]);
          expect(docsLinkRoots(managedDocsLinksOf(settled.data.links))).toEqual([
            fixture.primaryRoot,
          ]);
          expect(yield* fileSystem.exists(mountFor(fixture.primaryRoot))).toBe(true);
        }),
      ),
    { timeout: 60_000 },
  );

  retryIt.effect(
    "keeps bare retry as it was and leaves removing healthy mounts to clean",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const { mountFor, skillFor } = yield* mountDocs(fixture);
          const mount = mountFor(fixture.primaryRoot);
          const skill = skillFor(fixture.primaryRoot);

          successfulEnvelope(yield* runTack(fixture, ["state", "clean", "--pending", "--apply"]));
          expect(yield* fileSystem.exists(mount)).toBe(true);
          expect(yield* fileSystem.exists(skill)).toBe(true);

          successfulEnvelope(
            yield* runTack(fixture, ["state", "clean", "--project", "workspace", "--apply"]),
          );
          expect(yield* fileSystem.exists(mount)).toBe(false);
          expect(yield* fileSystem.exists(skill)).toBe(false);
        }),
      ),
    { timeout: 40_000 },
  );
});
