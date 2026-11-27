import { skillText } from "./support/source-tree.ts";
import { fakeGit } from "./support/fake-git.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import {
  Source,
  SourceRegistrationPayloadSchema,
  makeSourceService,
} from "../src/features/sources/source.ts";
import { SourceRemovalPlanSchema } from "../src/features/removal/source-removal.ts";
import { ProjectRemovalPlanSchema } from "../src/features/removal/project-removal.ts";
import type { GitService } from "../src/services/git.ts";
import { exitCodeForEnvelope } from "../src/cli/envelope/public-outcome.ts";
import { readState } from "../src/services/state-store.ts";
import { managedLinksOf } from "../src/domain/links/link-record-schema.ts";
import { managedDocsLinksOf } from "../src/domain/docs/docs-schema.ts";
import { runHost } from "./support/host-runner.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { mutateStateFixture, stateOptionsAt } from "./support/state-fixture.ts";
import { decodeEnvelope } from "./support/tack-process.ts";
import { write } from "./support/source-tree.ts";

const registrationOf = Schema.decodeUnknownSync(SourceRegistrationPayloadSchema);
const sourcePlanOf = Schema.decodeUnknownSync(SourceRemovalPlanSchema);
const projectPlanOf = Schema.decodeUnknownSync(ProjectRemovalPlanSchema);

const makeTack =
  (stateDirectory: string, git: GitService, home: string) => (args: ReadonlyArray<string>) =>
    runHost({ args: ["--json", "--state-dir", stateDirectory, ...args], git, env: { HOME: home } });

type Tack = ReturnType<typeof makeTack>;

/**
 * A machine with two sources, `brain` (the skill `review` and the docs `guide`) and `tools` (the
 * skill `lint`, which declares `depends-on: [brain]`), and the project `demo` with codex enabled.
 */
const withRemovalWorld = <A, E, R>(
  use: (world: {
    readonly brain: string;
    readonly brainId: string;
    readonly home: string;
    readonly options: {
      readonly stateDirectory: string;
      readonly homeDirectory: string;
    };
    readonly repository: string;
    readonly root: string;
    readonly tack: Tack;
    readonly toolsId: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "tack-removal-host-" }),
    );
    const home = path.join(root, "home");
    const repository = path.join(root, "repo");
    const stateDirectory = path.join(root, "state");
    const brain = path.join(root, "brain");
    const tools = path.join(root, "tools");
    yield* fs.makeDirectory(home, { recursive: true });
    yield* fs.makeDirectory(path.join(repository, ".git"), { recursive: true });
    yield* write(
      path.join(brain, "tack.yaml"),
      "version: 1\nname: brain\nskills:\n  - path: skills\ndocs:\n  - name: guide\n    path: guide\n",
    );
    yield* write(
      path.join(brain, "skills", "review", "SKILL.md"),
      skillText("review", { description: "Review", body: "" }),
    );
    yield* write(path.join(brain, "guide", "a.md"), "# A\n");
    yield* write(
      path.join(tools, "tack.yaml"),
      "version: 1\nname: tools\ndepends-on: [brain]\nskills:\n  - path: skills\n",
    );
    yield* write(
      path.join(tools, "skills", "lint", "SKILL.md"),
      skillText("lint", { description: "Lint", body: "" }),
    );
    const git = fakeGit(path.join(repository, ".git"), [{ path: repository }]);
    const tack = makeTack(stateDirectory, git, home);
    const idOf = (stdout: string) => {
      return registrationOf(decodeEnvelope(stdout).applied).registration.id;
    };
    yield* tack(["state", "init"]);
    const brainId = idOf((yield* tack(["source", "add", brain, "--apply"])).stdout);
    const toolsId = idOf((yield* tack(["source", "add", tools, "--apply"])).stdout);
    yield* tack(["project", "add", "demo", "--repository-cwd", repository]);
    yield* tack(["adapter", "enable", "codex"]);
    return yield* use({
      brain,
      brainId,
      home,
      options: stateOptionsAt(stateDirectory, home),
      repository,
      root,
      tack,
      toolsId,
    });
  });

/** Runs `effect` with Tack's own built-in source, which the live test layer leaves out. */
const withBuiltIns = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const builtins = {
      id: "00000000-0000-4000-8000-0000000000b2",
      canonicalPath: yield* fs.realPath(new URL("../src/builtins", import.meta.url).pathname),
    };
    const source = makeSourceService(yield* SecureRandom.SecureRandom, fs, yield* Path.Path, [
      builtins,
    ]);
    return yield* effect.pipe(Effect.provideService(Source, source));
  });

const run = Effect.fnUntraced(function* (tack: Tack, args: ReadonlyArray<string>) {
  const envelope = decodeEnvelope((yield* tack(args)).stdout);
  return { envelope, exitCode: exitCodeForEnvelope(envelope) };
});

const review = (sourceRegistrationId: string) => ({
  kind: "skill",
  name: "review",
  sourceRegistrationId,
});

/**
 * Picks and delivers `brain:review` in `demo` and at user level, and mounts `guide` in `demo`. The
 * user pick comes after the project sync, so `demo` keeps the link it made before.
 */
const deliverBrain = Effect.fnUntraced(function* (tack: Tack) {
  for (const args of [
    ["pick", "include", "brain:review", "--project", "demo"],
    ["docs", "--project", "demo", "attach", "brain:guide"],
    ["sync", "--project", "demo", "--apply"],
    ["pick", "include", "brain:review", "--user"],
    ["sync", "--user", "--apply"],
  ])
    expect((yield* run(tack, args)).exitCode).toBe(0);
});

it.layer(LiveTestLayer)("source and project removal", (removalIt) => {
  removalIt.effect(
    "previews then removes a source with its links, docs mount, picks and attachments",
    () =>
      withRemovalWorld(({ brain, brainId, options, tack, toolsId }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* deliverBrain(tack);
          const before = yield* readState(options);
          const brainLinks = managedLinksOf(before.data.links).filter(
            (evidence) => evidence.address.sourceRegistrationId === brainId,
          );
          expect(brainLinks).toHaveLength(2);
          expect(managedDocsLinksOf(before.data.links)).toHaveLength(1);

          const preview = yield* run(tack, ["source", "remove", "brain"]);
          expect(preview.exitCode).toBe(0);
          expect(preview.envelope).toMatchObject({
            applied: null,
            command: "source remove",
            plan: {
              kind: "source-removal-plan",
              version: 1,
              source: { id: brainId, label: "brain", canonicalPath: yield* fs.realPath(brain) },
              picks: [
                { namespace: { _tag: "user" }, address: review(brainId), decision: "include" },
                {
                  namespace: { _tag: "project", projectName: "demo" },
                  address: review(brainId),
                  decision: "include",
                },
              ],
              docsAttachments: [
                { projectName: "demo", sourceRegistrationId: brainId, name: "guide" },
              ],
              profileApplications: [],
              dependants: [{ sourceRegistrationId: toolsId, label: "tools", reason: "depends-on" }],
              removal: {
                cause: "clean",
                scope: { _tag: "source", sourceRegistrationId: brainId },
                docsActions: [{ action: "remove", evidence: { projectName: "demo" } }],
              },
            },
          });
          const plan = sourcePlanOf(preview.envelope.plan);
          expect(plan.removal.actions.map((action) => action._tag)).toEqual(["remove", "remove"]);
          expect(yield* readState(options)).toEqual(before);

          const applied = yield* run(tack, ["source", "remove", "brain", "--apply"]);
          expect(applied.exitCode).toBe(0);
          expect(applied.envelope).toMatchObject({
            command: "source remove",
            applied: { kind: "source-removal-application", version: 1, source: { id: brainId } },
          });
          for (const action of plan.removal.actions)
            expect(yield* fs.exists(action.destinationPath)).toBe(false);
          const after = yield* readState(options);
          expect(after.data.sources.map((source) => source.id)).toEqual([toolsId]);
          expect(after.data.userChoices).toEqual([]);
          expect(after.data.projects[0]?.choices ?? []).toEqual([]);
          expect(after.data.projects[0]?.docs?.attachments ?? []).toEqual([]);
          expect(
            after.data.links.filter((record) => record.resource.sourceRegistrationId === brainId),
          ).toEqual([]);
          // The source directory is the author's: removal never touches it.
          expect(yield* fs.exists(brain)).toBe(true);

          const again = yield* run(tack, ["source", "remove", "brain"]);
          expect(again.envelope).toMatchObject({
            status: "failure",
            diagnostics: [{ code: "source-not-found" }],
            next: ["tack source"],
          });
          expect(again.exitCode).toBe(2);
        }),
      ),
  );

  removalIt.effect("removes a source that is gone by its registration ID", () =>
    withRemovalWorld(({ brain, brainId, options, tack }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* deliverBrain(tack);
        yield* fs.remove(brain, { recursive: true });
        // A source that is gone has no label, so only its registration ID names it.
        expect((yield* run(tack, ["source", "remove", "brain"])).envelope).toMatchObject({
          diagnostics: [{ code: "source-not-found" }],
        });
        const preview = yield* run(tack, ["source", "remove", brainId]);
        expect(preview.envelope).toMatchObject({
          plan: {
            source: { id: brainId },
            removal: { docsActions: [{ action: "remove", evidence: { projectName: "demo" } }] },
          },
        });
        expect(sourcePlanOf(preview.envelope.plan).source).not.toHaveProperty("label");
        const applied = yield* run(tack, ["source", "remove", brainId, "--apply"]);
        expect(applied.exitCode).toBe(0);
        const after = yield* readState(options);
        expect(after.data.sources.some((source) => source.id === brainId)).toBe(false);
        expect(
          managedLinksOf(after.data.links).filter(
            (evidence) => evidence.address.sourceRegistrationId === brainId,
          ),
        ).toEqual([]);
      }),
    ),
  );

  removalIt.effect(
    "drops the profile applications a source publishes and reports the members others lose",
    () =>
      withRemovalWorld(({ brainId, options, root, tack, toolsId }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const lint = { kind: "skill" as const, name: "lint", sourceRegistrationId: toolsId };
          const brainReview = {
            kind: "skill" as const,
            name: "review",
            sourceRegistrationId: brainId,
          };
          const bundleId = "00000000-0000-4000-8000-0000000000b1";
          yield* mutateStateFixture(options, (state) => ({
            format: 1,
            data: {
              ...state.data,
              sources: [
                ...state.data.sources,
                {
                  id: bundleId,
                  canonicalPath: path.join(root, "state", "bundles", "a"),
                  bundle: {
                    identity: "a".repeat(64),
                    sourceKey: "shared",
                    bindings: { brain: brainId },
                    sourceKeys: { brain: "brain" },
                    files: [],
                  },
                },
              ],
              profileApplications: [
                {
                  namespace: { _tag: "project", projectName: "demo" },
                  profileName: "ci",
                  sourceRegistrationId: brainId,
                  direct: [brainReview],
                  inventory: [brainReview],
                  targets: [],
                },
                {
                  namespace: { _tag: "user" },
                  profileName: "kit",
                  sourceRegistrationId: toolsId,
                  direct: [lint],
                  inventory: [lint, brainReview],
                  targets: [],
                },
              ],
            },
          }));

          const preview = yield* run(tack, ["source", "remove", "brain"]);
          expect(preview.envelope).toMatchObject({
            plan: {
              profileApplications: [
                {
                  namespace: { _tag: "project", projectName: "demo" },
                  profileName: "ci",
                  sourceRegistrationId: brainId,
                  outcome: "dropped",
                  members: [brainReview],
                },
                {
                  namespace: { _tag: "user" },
                  profileName: "kit",
                  sourceRegistrationId: toolsId,
                  outcome: "unresolved",
                  members: [brainReview],
                },
              ],
              // Inspection lists bundle-provided sources first.
              dependants: [
                { sourceRegistrationId: bundleId, reason: "bundle-binding" },
                { sourceRegistrationId: toolsId, label: "tools", reason: "depends-on" },
              ],
            },
          });

          // A bundle-provided source owns retained bytes, so this round refuses it.
          expect((yield* run(tack, ["source", "remove", bundleId])).envelope).toMatchObject({
            status: "failure",
            diagnostics: [{ code: "source-bundle-provided" }],
          });

          expect((yield* run(tack, ["source", "remove", "brain", "--apply"])).exitCode).toBe(0);
          const after = yield* readState(options);
          expect(after.data.profileApplications?.map((entry) => entry.profileName)).toEqual([
            "kit",
          ]);

          // A source that no fixed application uses affects none of them.
          const extra = path.join(root, "extra");
          yield* write(
            path.join(extra, "tack.yaml"),
            "version: 1\nname: extra\nskills: [{path: skills}]\n",
          );
          yield* write(
            path.join(extra, "skills", "x", "SKILL.md"),
            skillText("x", { description: "X", body: "" }),
          );
          yield* tack(["source", "add", extra, "--apply"]);
          expect((yield* run(tack, ["source", "remove", "extra"])).envelope).toMatchObject({
            plan: { profileApplications: [], dependants: [] },
          });
        }),
      ),
  );

  removalIt.effect("refuses the built-in source and a label that names two sources", () =>
    withBuiltIns(
      withRemovalWorld(({ options, root, tack }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          expect((yield* run(tack, ["source", "remove", "tack"])).envelope).toMatchObject({
            status: "failure",
            diagnostics: [{ code: "source-builtin" }],
          });
          const twins = [path.join(root, "twin-a"), path.join(root, "twin-b")];
          const ids: Array<string> = [];
          for (const twin of twins) {
            yield* write(
              path.join(twin, "tack.yaml"),
              "version: 1\nname: twin\nskills: [{path: skills}]\n",
            );
            yield* write(
              path.join(twin, "skills", "x", "SKILL.md"),
              skillText("x", { description: "X", body: "" }),
            );
            ids.push(
              registrationOf(
                decodeEnvelope((yield* tack(["source", "add", twin, "--apply"])).stdout).applied,
              ).registration.id,
            );
          }
          const before = yield* readState(options);
          const ambiguous = yield* run(tack, ["source", "remove", "twin"]);
          expect(ambiguous.envelope).toMatchObject({
            status: "failure",
            diagnostics: [
              { code: "source-label-ambiguous", details: { candidates: ids.toSorted() } },
            ],
          });
          expect(yield* readState(options)).toEqual(before);
        }),
      ),
    ),
  );

  removalIt.effect(
    "previews then removes a whole project with its links, docs mount, picks and attachments",
    () =>
      withRemovalWorld(({ brainId, options, repository, tack }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* deliverBrain(tack);
          const ci = {
            namespace: { _tag: "project" as const, projectName: "demo" },
            profileName: "ci",
            sourceRegistrationId: brainId,
          };
          yield* mutateStateFixture(options, (state) => ({
            format: 1,
            data: {
              ...state.data,
              profileApplications: [
                { ...ci, direct: [], inventory: [], targets: [] },
                {
                  namespace: { _tag: "user" },
                  profileName: "kit",
                  sourceRegistrationId: brainId,
                  direct: [],
                  inventory: [],
                  targets: [],
                },
              ],
            },
          }));
          const before = yield* readState(options);

          const preview = yield* run(tack, ["project", "remove", "demo"]);
          expect(preview.exitCode).toBe(0);
          expect(preview.envelope).toMatchObject({
            applied: null,
            command: "project remove",
            plan: {
              kind: "project-removal-plan",
              version: 1,
              project: "demo",
              picks: [
                {
                  namespace: { _tag: "project", projectName: "demo" },
                  address: review(brainId),
                  decision: "include",
                },
              ],
              docsAttachments: [
                { projectName: "demo", sourceRegistrationId: brainId, name: "guide" },
              ],
              profileApplication: ci,
              removal: {
                cause: "project-removal",
                finalizeProject: true,
                scope: { _tag: "project", projectName: "demo" },
                docsActions: [{ action: "remove", evidence: { projectName: "demo" } }],
              },
            },
          });
          const plan = projectPlanOf(preview.envelope.plan);
          // `tools:lint` is on by default, so the project holds its link beside `brain:review`.
          expect(plan.removal.actions.map((action) => action._tag)).toEqual(["remove", "remove"]);
          expect(yield* readState(options)).toEqual(before);

          const applied = yield* run(tack, ["project", "remove", "demo", "--apply"]);
          expect(applied.exitCode).toBe(0);
          expect(applied.envelope).toMatchObject({
            applied: {
              kind: "project-removal-application",
              project: "demo",
              removal: { finalizedProject: true },
            },
          });
          for (const action of plan.removal.actions)
            expect(yield* fs.exists(action.destinationPath)).toBe(false);
          const after = yield* readState(options);
          expect(after.data.projects).toEqual([]);
          expect(managedDocsLinksOf(after.data.links)).toEqual([]);
          // The worktree is the operator's: removal never touches it.
          expect(yield* fs.exists(repository)).toBe(true);
          // User-level intent belongs to no project and stays.
          expect(after.data.userChoices).toHaveLength(1);
          expect(after.data.profileApplications?.map((entry) => entry.profileName)).toEqual([
            "kit",
          ]);

          expect((yield* run(tack, ["project", "remove", "demo"])).envelope).toMatchObject({
            status: "failure",
            diagnostics: [{ code: "project-not-found" }],
          });
        }),
      ),
  );

  removalIt.effect(
    "keeps a project in removal until a blocked link settles, then finishes on a second apply",
    () =>
      withRemovalWorld(({ options, tack }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* deliverBrain(tack);
          const link = managedLinksOf((yield* readState(options)).data.links).find(
            (evidence) => evidence.target._tag === "project-root",
          );
          const preview = yield* run(tack, ["project", "remove", "demo"]);
          const destination = projectPlanOf(preview.envelope.plan).removal.actions[0]!
            .destinationPath;
          expect(link).toBeDefined();
          yield* fs.remove(destination);
          yield* fs.writeFileString(destination, "foreign\n");

          const blocked = yield* run(tack, ["project", "remove", "demo", "--apply"]);
          expect(blocked.exitCode).toBe(1);
          expect(blocked.envelope).toMatchObject({
            status: "partial",
            applied: { removal: { finalizedProject: false } },
          });
          expect(yield* fs.readFileString(destination)).toBe("foreign\n");
          expect((yield* readState(options)).data.projects).toMatchObject([
            { name: "demo", removalIntent: "project", roots: [] },
          ]);

          yield* fs.remove(destination);
          const finished = yield* run(tack, ["project", "remove", "demo", "--apply"]);
          expect(finished.exitCode).toBe(0);
          expect((yield* readState(options)).data.projects).toEqual([]);
        }),
      ),
  );
});
