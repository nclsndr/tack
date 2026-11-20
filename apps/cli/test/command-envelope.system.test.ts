import { writeUnder } from "./support/source-tree.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ReconciliationApplyResultSchema } from "../src/features/reconciliation/reconciliation-application.ts";
import { SyncApplicationSchema, SyncPlanSchema } from "../src/domain/reconciliation/sync-schema.ts";
import {
  ReconciliationCommandPlanSchema,
  ReconciliationPlanSchema,
} from "../src/domain/reconciliation/reconciliation-schema.ts";
import { CatalogReportSchema } from "../src/domain/sources/catalog-report.ts";
import { runProcess } from "./fixtures/tack-world.ts";
import {
  builtEntrypoint,
  decodeEnvelope,
  repositoryRoot,
  sourceEntrypoint,
  tackEnvironment,
  tackProcess,
  type TackIsolation,
  type TackRun,
} from "./support/tack-process.ts";

type CliFixture = {
  readonly destinationSentinelPath: string;
  readonly homeDirectory: string;
  readonly repositoryDirectory: string;
  readonly sourceDirectory: string;
  readonly stateDirectory: string;
  readonly worktreeDirectory: string;
};

const envelope = (result: TackRun) => decodeEnvelope(result.stdout);
const resourcePlan = (result: TackRun) => {
  const plan = Schema.decodeUnknownSync(SyncPlanSchema)(envelope(result).plan);
  if (plan.resources === null) throw new Error("Expected resource plan.");
  return plan.resources;
};

const expectSuccess = (result: TackRun) => {
  expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(0));
  expect(result.stderr).toBe("");
  expect(envelope(result)).toMatchObject({
    classification: "success",
    status: "success",
    version: 1,
  });
};

const expectProcessSuccess = (result: TackRun) => {
  expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(0));
};

const withFixture = <A, E, R>(use: (fixture: CliFixture) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-test-" });
    const root = yield* fileSystem.realPath(temporaryRoot);
    const homeDirectory = path.join(root, "home");
    const repositoryDirectory = path.join(root, "repository");
    const sourceDirectory = path.join(root, "source");
    const stateDirectory = path.join(root, "state");
    const worktreeDirectory = path.join(root, "worktree");
    const destinationSentinelPath = path.join(homeDirectory, "destination-sentinel.txt");
    yield* fileSystem.makeDirectory(homeDirectory, { recursive: true });
    yield* fileSystem.makeDirectory(repositoryDirectory, { recursive: true });
    yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(sourceDirectory, "tack.yaml"),
      "version: 1\nskills:\n  - path: skills\n",
    );
    yield* fileSystem.makeDirectory(path.join(sourceDirectory, "skills", "valid"), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(
      path.join(sourceDirectory, "skills", "valid", "SKILL.md"),
      "---\nname: valid\ndescription: Valid skill\nmetadata:\n  tack: |\n    version: 1\n    user-activation: default\n---\n",
    );
    yield* fileSystem.writeFileString(destinationSentinelPath, "operator-owned\n");

    return yield* use({
      destinationSentinelPath,
      homeDirectory,
      repositoryDirectory,
      sourceDirectory,
      stateDirectory,
      worktreeDirectory,
    });
  });

/** The fixture's own home and state, so no run reaches the operator's. */
const isolationOf = (fixture: CliFixture): TackIsolation => ({
  home: fixture.homeDirectory,
  state: fixture.stateDirectory,
});

/** Runs one Tack entrypoint with `--json` against the fixture's isolated home and state. */
const runTack = (
  entrypoint: string,
  fixture: CliFixture,
  arguments_: ReadonlyArray<string>,
  cwd: string = fixture.repositoryDirectory,
) => tackProcess(["--json", ...arguments_], { ...isolationOf(fixture), cwd, entrypoint });

const runGit = (cwd: string, arguments_: ReadonlyArray<string>) =>
  runProcess("git", arguments_, { cwd });

it.layer(LiveTestLayer)("command envelope at the process boundary", (cliIt) => {
  cliIt.effect.each(["missing", "invalid-declaration"] as const)(
    "keeps unhealthy source inspection JSON-safe and partial for %s while retaining independent results",
    (failure) =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const independent = path.join(
            path.dirname(fixture.sourceDirectory),
            "independent-source",
          );
          const independentSkill = path.join(independent, "skills", "independent");
          const movedSource = `${fixture.sourceDirectory}-moved`;
          yield* fs.makeDirectory(independentSkill, { recursive: true });
          yield* fs.writeFileString(
            path.join(independent, "tack.yaml"),
            "version: 1\nskills:\n  - path: skills\n",
          );
          yield* fs.writeFileString(
            path.join(independentSkill, "SKILL.md"),
            "---\nname: independent\ndescription: Independent\nmetadata:\n  tack: |\n    version: 1\n    user-activation: default\n---\n",
          );
          for (const args of [
            ["state", "init"],
            ["source", "add", fixture.sourceDirectory],
            ["source", "add", independent],
            ["adapter", "enable", "cursor"],
            ["sync", "--user", "--apply"],
          ]) {
            expectSuccess(yield* runTack(sourceEntrypoint, fixture, args));
          }
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const before = yield* fs.readFileString(statePath);
          const destination = path.join(fixture.homeDirectory, ".cursor", "skills");
          const linkText = yield* fs.readLink(path.join(destination, "valid"));
          if (failure === "missing") yield* fs.rename(fixture.sourceDirectory, movedSource);
          else
            yield* fs.writeFileString(
              path.join(fixture.sourceDirectory, "tack.yaml"),
              "version: 99\n",
            );
          const code = failure === "missing" ? "source-missing" : "declaration-version-unsupported";
          const catalog = yield* runTack(sourceEntrypoint, fixture, ["catalog"]);
          const inspected = yield* runTack(sourceEntrypoint, fixture, ["source"]);
          for (const result of [catalog, inspected]) {
            expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
            expect(result.stderr).toBe("");
            expect(envelope(result)).toMatchObject({
              status: "partial",
              classification: "partial",
            });
            expect(result.stdout).not.toContain('"stack"');
            expect(result.stdout).not.toContain('"cause"');
            expect(result.stdout).not.toContain('"_tag":"Source');
          }
          expect(envelope(catalog)).toMatchObject({
            diagnostics: [{ code: "catalog-partial", details: { issues: 1 }, severity: "warning" }],
            result: {
              kind: "catalog",
              complete: false,
              resources: expect.arrayContaining([
                expect.objectContaining({
                  kind: "skill",
                  origin: "builtin",
                  address: expect.objectContaining({ name: "use-tack" }),
                }),
                expect.objectContaining({
                  kind: "skill",
                  origin: "registered",
                  address: expect.objectContaining({ name: "independent" }),
                }),
              ]),
              issues: [
                {
                  code,
                  message: expect.any(String),
                  subject: { _tag: "source", sourcePath: fixture.sourceDirectory },
                },
              ],
            },
          });
          expect(envelope(inspected)).toMatchObject({
            diagnostics: [
              {
                code: "source-unhealthy",
                details: {
                  subject: {
                    issue: { code },
                    registration: { canonicalPath: fixture.sourceDirectory },
                  },
                },
                severity: "warning",
              },
            ],
            result: { kind: "source-inspections" },
          });
          expect(envelope(inspected).result).toMatchObject({
            sources: expect.arrayContaining([
              expect.objectContaining({ origin: "builtin", status: "healthy" }),
              expect.objectContaining({
                status: "unhealthy",
                issue: expect.objectContaining({
                  code,
                  message: expect.any(String),
                  sourcePath: fixture.sourceDirectory,
                }),
              }),
              expect.objectContaining({
                status: "healthy",
                registration: expect.objectContaining({ canonicalPath: independent }),
              }),
            ]),
          });
          expect(envelope(inspected).result).toMatchObject({ sources: { length: 3 } });
          for (const args of [
            ["status", "--user"],
            ["sync", "--user"],
            ["sync", "--user"],
          ]) {
            const result = yield* runTack(sourceEntrypoint, fixture, args);
            expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
            expect(envelope(result)).toMatchObject({ classification: "partial" });
          }
          expect(yield* fs.readFileString(statePath)).toBe(before);
          expect(yield* fs.readLink(path.join(destination, "valid"))).toBe(linkText);
          expect(yield* fs.realPath(path.join(destination, "independent"))).toBe(independentSkill);
          if (failure === "missing") yield* fs.rename(movedSource, fixture.sourceDirectory);
          else
            yield* fs.writeFileString(
              path.join(fixture.sourceDirectory, "tack.yaml"),
              "version: 1\nskills:\n  - path: skills\n",
            );
          for (const args of [["catalog"], ["source"]])
            expectSuccess(yield* runTack(sourceEntrypoint, fixture, args));
          expect(yield* fs.readFileString(statePath)).toBe(before);
          expect(yield* fs.readLink(path.join(destination, "valid"))).toBe(linkText);
        }),
      ),
  );
  cliIt.effect("runs source initialization through one JSON-only host boundary", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const result = yield* runTack(sourceEntrypoint, fixture, ["state", "init"]);

        expectSuccess(result);
        expect(envelope(result)).toMatchObject({
          applied: { stateDirectory: fixture.stateDirectory },
          command: "state init",
        });
        const missingProject = yield* runTack(sourceEntrypoint, fixture, [
          "sync",
          "--project",
          "missing",
        ]);
        const invalidSelector = yield* runTack(sourceEntrypoint, fixture, [
          "sync",
          "--project",
          "missing",
          "--user",
        ]);

        expect(missingProject.exitCode).toBe(ChildProcessSpawner.ExitCode(2));
        expect(envelope(missingProject)).toMatchObject({
          classification: "invalid-configuration",
          diagnostics: [
            expect.objectContaining({
              code: "project-not-found",
              details: { projectName: "missing" },
            }),
          ],
        });
        expect(invalidSelector.exitCode).toBe(ChildProcessSpawner.ExitCode(2));
        expect(envelope(invalidSelector)).toMatchObject({
          classification: "invalid-invocation",
          diagnostics: [expect.objectContaining({ code: "invalid-selector" })],
        });
      }),
    ),
  );

  cliIt.effect(
    "uses real Git worktrees while preserving reinitialization and read-only snapshots",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const dotenvPath = path.join(fixture.stateDirectory, ".env");
          const sourceSkillPath = path.join(fixture.sourceDirectory, "skills", "valid", "SKILL.md");
          const outsideDirectory = path.join(fixture.homeDirectory, "outside");
          yield* fileSystem.makeDirectory(outsideDirectory, { recursive: true });

          for (const args of [
            ["state", "init"],
            ["source", "add", fixture.sourceDirectory],
          ] satisfies ReadonlyArray<ReadonlyArray<string>>) {
            expectSuccess(yield* runTack(sourceEntrypoint, fixture, args));
          }

          for (const args of [
            ["init"],
            ["config", "user.email", "tack@example.test"],
            ["config", "user.name", "Tack Test"],
          ] satisfies ReadonlyArray<ReadonlyArray<string>>) {
            const result = yield* runGit(fixture.repositoryDirectory, args);
            expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(0));
          }
          yield* fileSystem.writeFileString(
            path.join(fixture.repositoryDirectory, "README.md"),
            "initial\n",
          );
          expectProcessSuccess(yield* runGit(fixture.repositoryDirectory, ["add", "README.md"]));
          expectProcessSuccess(
            yield* runGit(fixture.repositoryDirectory, ["commit", "-m", "initial"]),
          );
          expectProcessSuccess(
            yield* runGit(fixture.repositoryDirectory, [
              "worktree",
              "add",
              "-b",
              "phase-one-worktree",
              fixture.worktreeDirectory,
            ]),
          );
          const projectAdd = yield* runTack(sourceEntrypoint, fixture, [
            "project",
            "add",
            "workspace",
            "--repository-cwd",
            fixture.repositoryDirectory,
          ]);
          expectSuccess(projectAdd);
          const expectedRoots = [
            yield* fileSystem.realPath(fixture.repositoryDirectory),
            yield* fileSystem.realPath(fixture.worktreeDirectory),
          ].sort();
          expect(envelope(projectAdd).applied).toMatchObject({
            alreadyRegistered: false,
            project: {
              gitCommonDirectory: yield* fileSystem.realPath(
                path.join(fixture.repositoryDirectory, ".git"),
              ),
              name: "workspace",
              roots: expectedRoots,
            },
          });

          yield* fileSystem.writeFileString(dotenvPath, "TACK_TOKEN=operator-value\n");
          const stateBeforeReinitialize = yield* fileSystem.readFileString(statePath);
          const dotenvBeforeReinitialize = yield* fileSystem.readFileString(dotenvPath);
          const dotenvModeBeforeReinitialize = (yield* fileSystem.stat(dotenvPath)).mode;
          const reinitialized = yield* runTack(sourceEntrypoint, fixture, ["state", "init"]);

          expectSuccess(reinitialized);
          expect(envelope(reinitialized).applied).toMatchObject({ alreadyInitialized: true });
          expect(yield* fileSystem.readFileString(statePath)).toBe(stateBeforeReinitialize);
          expect(yield* fileSystem.readFileString(dotenvPath)).toBe(dotenvBeforeReinitialize);
          expect((yield* fileSystem.stat(dotenvPath)).mode).toBe(dotenvModeBeforeReinitialize);

          const stateBeforeReadOnly = yield* fileSystem.readFileString(statePath);
          const dotenvBeforeReadOnly = yield* fileSystem.readFileString(dotenvPath);
          const skillBeforeReadOnly = yield* fileSystem.readFileString(sourceSkillPath);
          const destinationBeforeReadOnly = yield* fileSystem.readFileString(
            fixture.destinationSentinelPath,
          );
          const sourceInspection = yield* runTack(sourceEntrypoint, fixture, ["source"]);
          const projectInspection = yield* runTack(sourceEntrypoint, fixture, ["project"]);
          const catalog = yield* runTack(sourceEntrypoint, fixture, ["catalog"]);
          // Plans contain units only for selected adapters, so name one to observe the targets.
          const barePlan = yield* runTack(
            sourceEntrypoint,
            fixture,
            ["sync", "--adapter", "codex"],
            fixture.worktreeDirectory,
          );
          const repeatedBarePlan = yield* runTack(
            sourceEntrypoint,
            fixture,
            ["sync", "--adapter", "codex"],
            fixture.worktreeDirectory,
          );
          const projectPlan = yield* runTack(sourceEntrypoint, fixture, [
            "sync",
            "--adapter",
            "codex",
            "--project",
            "workspace",
          ]);
          const userPlan = yield* runTack(sourceEntrypoint, fixture, [
            "sync",
            "--adapter",
            "codex",
            "--user",
          ]);
          const unauthorizedBarePlan = yield* runTack(sourceEntrypoint, fixture, [
            "sync",
            "--adapter",
            "codex",
            "--cwd",
            outsideDirectory,
          ]);

          for (const result of [
            sourceInspection,
            projectInspection,
            catalog,
            barePlan,
            repeatedBarePlan,
            projectPlan,
            userPlan,
          ]) {
            expectSuccess(result);
          }
          expect(repeatedBarePlan.stdout).toBe(barePlan.stdout);
          expect(envelope(sourceInspection).result).toMatchObject({
            kind: "source-inspections",
            sources: [
              { origin: "builtin", status: "healthy" },
              { registration: { canonicalPath: expect.stringMatching(/\/source$/) } },
            ],
          });
          expect(envelope(projectInspection).result).toMatchObject({
            kind: "project-inspections",
            projects: [{ project: { name: "workspace" } }],
          });
          expect(envelope(catalog).result).toMatchObject({
            complete: true,
            issues: [],
            resources: expect.arrayContaining([
              expect.objectContaining({
                origin: "builtin",
                address: expect.objectContaining({ name: "use-tack" }),
              }),
              expect.objectContaining({ address: expect.objectContaining({ name: "valid" }) }),
            ]),
          });
          const planTargets = (result: TackRun) =>
            Schema.decodeUnknownSync(ReconciliationPlanSchema)(resourcePlan(result)).units.map(
              (unit) => unit.target,
            );
          expect(envelope(barePlan)).toMatchObject({
            command: "sync",
            plan: { kind: "sync-plan", resources: { kind: "skill-reconciliation-plan" } },
          });
          expect(planTargets(barePlan)).toEqual(planTargets(projectPlan));
          const barePayload = Schema.decodeUnknownSync(ReconciliationCommandPlanSchema)(
            resourcePlan(barePlan),
          );
          const namedPayload = Schema.decodeUnknownSync(ReconciliationCommandPlanSchema)(
            resourcePlan(projectPlan),
          );
          const { selection: bareSelection, ...bareFacts } = barePayload;
          const { selection: namedSelection, ...namedFacts } = namedPayload;
          expect(bareSelection).toBeDefined();
          expect(namedSelection).toBeDefined();
          expect(bareFacts).toEqual(namedFacts);
          expect(planTargets(projectPlan)).toEqual(
            expectedRoots.map((canonicalPath) => ({
              _tag: "project-root",
              canonicalPath,
              projectName: "workspace",
            })),
          );
          expect(planTargets(userPlan)).toEqual([
            { _tag: "user", canonicalPath: fixture.homeDirectory },
          ]);
          // Plans echo the requested selector, what authorized a bare one, and the resolved targets.
          expect(resourcePlan(barePlan)).toMatchObject({
            selection: {
              containingRoot: { projectName: "workspace", root: fixture.worktreeDirectory },
              selector: { _tag: "bare" },
              targets: expectedRoots.map((canonicalPath) => ({
                _tag: "project-root",
                canonicalPath,
                projectName: "workspace",
              })),
            },
          });
          expect(resourcePlan(projectPlan)).toMatchObject({
            selection: {
              selector: { _tag: "project", projectName: "workspace" },
              targets: expectedRoots.map((canonicalPath) => ({
                _tag: "project-root",
                canonicalPath,
                projectName: "workspace",
              })),
            },
          });
          expect(resourcePlan(projectPlan)).not.toHaveProperty("selection.containingRoot");
          expect(JSON.stringify(envelope(projectPlan).plan)).not.toContain(fixture.homeDirectory);
          expect(unauthorizedBarePlan.exitCode).toBe(ChildProcessSpawner.ExitCode(2));
          expect(unauthorizedBarePlan.stderr).toBe("");
          expect(envelope(unauthorizedBarePlan)).toMatchObject({
            classification: "invalid-configuration",
            diagnostics: [
              expect.objectContaining({
                code: "bare-target-requires-registered-root",
                message:
                  "This directory is not inside a registered project. Choose --project NAME, --user or --all.",
              }),
            ],
            status: "failure",
          });
          expect(yield* fileSystem.readFileString(statePath)).toBe(stateBeforeReadOnly);
          expect(yield* fileSystem.readFileString(dotenvPath)).toBe(dotenvBeforeReadOnly);
          expect(yield* fileSystem.readFileString(sourceSkillPath)).toBe(skillBeforeReadOnly);
          expect(yield* fileSystem.readFileString(fixture.destinationSentinelPath)).toBe(
            destinationBeforeReadOnly,
          );

          yield* fileSystem.makeDirectory(path.join(fixture.sourceDirectory, "skills", "invalid"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(fixture.sourceDirectory, "skills", "invalid", "SKILL.md"),
            "---\nname: other\ndescription: Invalid\n---\n",
          );
          yield* fileSystem.makeDirectory(
            path.join(fixture.sourceDirectory, "skills", "malformed"),
            {
              recursive: true,
            },
          );
          yield* fileSystem.writeFileString(
            path.join(fixture.sourceDirectory, "skills", "malformed", "SKILL.md"),
            "---\nname: malformed\ndescription: [\n---\n",
          );
          for (const directory of ["one/duplicate", "two/duplicate"]) {
            const skillDirectory = path.join(fixture.sourceDirectory, "skills", directory);
            yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
            yield* fileSystem.writeFileString(
              path.join(skillDirectory, "SKILL.md"),
              "---\nname: duplicate\ndescription: Duplicate skill\n---\n",
            );
          }
          const partialCatalog = yield* runTack(sourceEntrypoint, fixture, ["catalog"]);
          const partialPlan = yield* runTack(sourceEntrypoint, fixture, [
            "sync",
            "--adapter",
            "codex",
            "--project",
            "workspace",
          ]);

          for (const [result, code] of [
            [partialCatalog, "catalog-partial"],
            [partialPlan, "catalog-quarantined"],
          ] as const) {
            expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
            expect(result.stderr).toBe("");
            expect(envelope(result)).toMatchObject({
              classification: "partial",
              diagnostics: expect.arrayContaining([expect.objectContaining({ code })]),
              status: "partial",
            });
          }
          expect(envelope(partialCatalog).result).toMatchObject({
            complete: false,
            resources: expect.arrayContaining([
              expect.objectContaining({
                origin: "builtin",
                address: expect.objectContaining({ name: "use-tack" }),
              }),
              expect.objectContaining({ address: expect.objectContaining({ name: "valid" }) }),
            ]),
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "skill-address-duplicate" }),
              expect.objectContaining({ code: "skill-frontmatter-yaml-malformed" }),
              expect.objectContaining({ code: "skill-name-mismatch" }),
            ]),
          });
          expect(planTargets(partialPlan)).toEqual(
            expectedRoots.map((canonicalPath) => ({
              _tag: "project-root",
              canonicalPath,
              projectName: "workspace",
            })),
          );
        }),
      ),
    { timeout: 20_000 },
  );

  cliIt.effect("fails closed for corrupt state without changing external files", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const statePath = path.join(fixture.stateDirectory, "state.json");
        const sourceDeclaration = path.join(fixture.sourceDirectory, "tack.yaml");
        const destinationPath = path.join(fixture.homeDirectory, "destination.txt");
        expectSuccess(yield* runTack(sourceEntrypoint, fixture, ["state", "init"]));
        yield* fileSystem.writeFileString(statePath, "{ corrupt");
        yield* fileSystem.writeFileString(destinationPath, "preserve\n");
        const stateBefore = yield* fileSystem.readFileString(statePath);
        const sourceBefore = yield* fileSystem.readFileString(sourceDeclaration);
        const destinationBefore = yield* fileSystem.readFileString(destinationPath);

        const result = yield* runTack(sourceEntrypoint, fixture, [
          "source",
          "add",
          fixture.sourceDirectory,
        ]);
        const plan = yield* runTack(sourceEntrypoint, fixture, ["sync", "--user"]);

        for (const failure of [result, plan]) {
          expect(failure.exitCode).toBe(ChildProcessSpawner.ExitCode(3));
          expect(failure.stderr).toBe("");
          expect(envelope(failure)).toMatchObject({
            classification: "persistence",
            diagnostics: [expect.objectContaining({ code: "state-corrupt" })],
            status: "failure",
          });
          expect(failure.stdout).not.toContain("ParseError");
        }
        expect(yield* fileSystem.readFileString(statePath)).toBe(stateBefore);
        expect(yield* fileSystem.readFileString(sourceDeclaration)).toBe(sourceBefore);
        expect(yield* fileSystem.readFileString(destinationPath)).toBe(destinationBefore);
      }),
    ),
  );

  cliIt.effect(
    "reconciles exact choices with invocation-only adapters and optional dependencies",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const optionalDirectory = path.join(fixture.sourceDirectory, "skills", "optional");
          yield* fileSystem.writeFileString(
            path.join(fixture.sourceDirectory, "skills", "valid", "SKILL.md"),
            "---\nname: valid\ndescription: Valid skill\nmetadata:\n  tack: |\n    version: 1\n    dependencies:\n      - source: source\n        kind: skill\n        name: optional\n        optional: true\n---\n",
          );
          yield* fileSystem.makeDirectory(optionalDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(optionalDirectory, "SKILL.md"),
            "---\nname: optional\ndescription: Optional skill\nmetadata:\n  tack: |\n    version: 1\n    activation: opt-in\n---\n",
          );

          for (const args of [
            ["init"],
            ["config", "user.email", "tack@example.test"],
            ["config", "user.name", "Tack Test"],
          ] satisfies ReadonlyArray<ReadonlyArray<string>>) {
            expectProcessSuccess(yield* runGit(fixture.repositoryDirectory, args));
          }
          yield* fileSystem.writeFileString(
            path.join(fixture.repositoryDirectory, "README.md"),
            "phase two\n",
          );
          expectProcessSuccess(yield* runGit(fixture.repositoryDirectory, ["add", "README.md"]));
          expectProcessSuccess(
            yield* runGit(fixture.repositoryDirectory, ["commit", "-m", "phase two"]),
          );

          for (const args of [
            ["state", "init"],
            ["source", "add", fixture.sourceDirectory],
            ["project", "add", "workspace", "--repository-cwd", fixture.repositoryDirectory],
            ["adapter", "enable", "cursor", "codex"],
            ["pick", "include", "valid", "--project", "workspace"],
          ] satisfies ReadonlyArray<ReadonlyArray<string>>) {
            expectSuccess(yield* runTack(sourceEntrypoint, fixture, args));
          }

          const choicesBefore = yield* runTack(sourceEntrypoint, fixture, [
            "pick",
            "--project",
            "workspace",
          ]);
          const stateBeforeDryRun = yield* fileSystem.readFileString(statePath);
          const cursorSkillDirectory = path.join(fixture.repositoryDirectory, ".cursor", "skills");
          const codexSkillDirectory = path.join(fixture.repositoryDirectory, ".agents", "skills");
          const reconciliationArguments = [
            "sync",
            "--project",
            "workspace",
            "--adapter",
            "cursor",
            "--include-optional",
            "--require-capability",
            "skill-links",
          ] as const;
          const dryRun = yield* runTack(sourceEntrypoint, fixture, reconciliationArguments);

          expectSuccess(dryRun);
          expect(envelope(dryRun)).toMatchObject({
            applied: null,
            command: "sync",
            plan: {
              kind: "sync-plan",
              resources: {
                kind: "skill-reconciliation-plan",
                namespaceResolutions: [
                  {
                    namespace: { _tag: "project", projectName: "workspace" },
                    resolution: {
                      groups: expect.arrayContaining([
                        expect.objectContaining({ _tag: "selected" }),
                      ]),
                    },
                  },
                ],
              },
            },
            result: null,
          });
          const dryUnits = Schema.decodeUnknownSync(
            Schema.Struct({ units: Schema.Array(Schema.Unknown) }),
          )(resourcePlan(dryRun)).units;
          expect(dryUnits).toEqual([
            expect.objectContaining({
              adapter: "cursor",
              capability: expect.objectContaining({
                _tag: "supported",
                capability: "skill-links",
              }),
            }),
          ]);
          expect(yield* fileSystem.readFileString(statePath)).toBe(stateBeforeDryRun);
          expect(yield* fileSystem.exists(cursorSkillDirectory)).toBe(false);
          expect(yield* fileSystem.exists(codexSkillDirectory)).toBe(false);

          const applied = yield* runTack(sourceEntrypoint, fixture, [
            ...reconciliationArguments,
            "--apply",
          ]);
          expectSuccess(applied);
          expect(envelope(applied)).toMatchObject({
            applied: {
              kind: "sync-application",
              resources: { kind: "skill-reconciliation-application" },
            },
            plan: { kind: "sync-plan", resources: { kind: "skill-reconciliation-plan" } },
          });
          expect(envelope(applied).plan).toEqual(envelope(dryRun).plan);
          for (const name of ["optional", "valid"]) {
            const destination = path.join(cursorSkillDirectory, name);
            expect(path.isAbsolute(yield* fileSystem.readLink(destination))).toBe(false);
            expect(yield* fileSystem.realPath(destination)).toBe(
              yield* fileSystem.realPath(path.join(fixture.sourceDirectory, "skills", name)),
            );
          }
          expect(yield* fileSystem.exists(codexSkillDirectory)).toBe(false);

          const adaptersAfterOverride = yield* runTack(sourceEntrypoint, fixture, [
            "adapter",
            "list",
          ]);
          const choicesAfterOptional = yield* runTack(sourceEntrypoint, fixture, [
            "pick",
            "--project",
            "workspace",
          ]);
          expectSuccess(adaptersAfterOverride);
          expectSuccess(choicesAfterOptional);
          expect(envelope(adaptersAfterOverride).result).toEqual({
            kind: "adapters",
            enabledAdapters: ["codex", "cursor"],
          });
          expect(envelope(choicesAfterOptional).result).toEqual(envelope(choicesBefore).result);

          const ordinaryApply = yield* runTack(sourceEntrypoint, fixture, [
            "sync",
            "--project",
            "workspace",
            "--apply",
          ]);
          expectSuccess(ordinaryApply);
          expect(yield* fileSystem.exists(path.join(cursorSkillDirectory, "optional"))).toBe(false);
          expect(yield* fileSystem.realPath(path.join(cursorSkillDirectory, "valid"))).toBe(
            yield* fileSystem.realPath(path.join(fixture.sourceDirectory, "skills", "valid")),
          );
          expect(yield* fileSystem.realPath(path.join(codexSkillDirectory, "valid"))).toBe(
            yield* fileSystem.realPath(path.join(fixture.sourceDirectory, "skills", "valid")),
          );

          const idempotent = yield* runTack(sourceEntrypoint, fixture, [
            "sync",
            "--project",
            "workspace",
            "--apply",
          ]);
          expectSuccess(idempotent);
          expect(resourcePlan(idempotent)).toMatchObject({
            units: [
              expect.objectContaining({ actions: [] }),
              expect.objectContaining({ actions: [] }),
            ],
          });

          const beforeMissingPick = yield* fileSystem.readFileString(statePath);
          const missing = yield* runTack(sourceEntrypoint, fixture, [
            "pick",
            "include",
            "missing",
            "--user",
          ]);
          expect(missing.exitCode).toBe(ChildProcessSpawner.ExitCode(2));
          expect(envelope(missing).classification).toBe("invalid-configuration");
          expect(yield* fileSystem.readFileString(statePath)).toBe(beforeMissingPick);
        }),
      ),
  );

  cliIt.effect("keeps dry-run plans invariant when agent application artifacts appear", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (const args of [
          ["state", "init"],
          ["source", "add", fixture.sourceDirectory],
          ["adapter", "enable", "codex", "cursor"],
        ] satisfies ReadonlyArray<ReadonlyArray<string>>) {
          expectSuccess(yield* runTack(sourceEntrypoint, fixture, args));
        }
        const cursorDestinationDirectory = path.join(fixture.homeDirectory, ".cursor", "skills");
        const codexDestinationDirectory = path.join(fixture.homeDirectory, ".agents", "skills");
        const reconcileArguments = ["sync", "--user"] as const;
        const absent = yield* runTack(sourceEntrypoint, fixture, reconcileArguments);
        expectSuccess(absent);

        for (const application of ["Cursor", "Codex"]) {
          const executableDirectory = path.join(
            fixture.homeDirectory,
            "Applications",
            `${application}.app`,
            "Contents",
            "MacOS",
          );
          yield* fileSystem.makeDirectory(executableDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(executableDirectory, application.toLowerCase()),
            "fake application artifact\n",
          );
        }
        const present = yield* runTack(sourceEntrypoint, fixture, reconcileArguments);
        expectSuccess(present);

        expect(envelope(present).plan).toEqual(envelope(absent).plan);
        expect(
          Schema.decodeUnknownSync(ReconciliationPlanSchema)(resourcePlan(present)).units.map(
            (unit) => unit.adapter,
          ),
        ).toEqual(["codex", "cursor"]);
        expect(yield* fileSystem.exists(cursorDestinationDirectory)).toBe(false);
        expect(yield* fileSystem.exists(codexDestinationDirectory)).toBe(false);
      }),
    ),
  );

  cliIt.effect("preserves foreign destinations while applying an independent adapter unit", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const codexDestination = path.join(fixture.homeDirectory, ".agents", "skills", "valid");
        const cursorDestination = path.join(fixture.homeDirectory, ".cursor", "skills", "valid");
        yield* fileSystem.makeDirectory(path.dirname(codexDestination), { recursive: true });
        yield* fileSystem.writeFileString(codexDestination, "operator-owned\n");

        for (const args of [
          ["state", "init"],
          ["source", "add", fixture.sourceDirectory],
          ["adapter", "enable", "codex", "cursor"],
        ] satisfies ReadonlyArray<ReadonlyArray<string>>) {
          expectSuccess(yield* runTack(sourceEntrypoint, fixture, args));
        }

        const result = yield* runTack(sourceEntrypoint, fixture, ["sync", "--user", "--apply"]);

        expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
        expect(envelope(result)).toMatchObject({
          applied: {
            kind: "sync-application",
            resources: { kind: "skill-reconciliation-application" },
          },
          classification: "partial",
          diagnostics: [expect.objectContaining({ code: "foreign-destination" })],
          plan: { kind: "sync-plan", resources: { kind: "skill-reconciliation-plan" } },
        });
        expect(yield* fileSystem.readFileString(codexDestination)).toBe("operator-owned\n");
        expect(path.isAbsolute(yield* fileSystem.readLink(cursorDestination))).toBe(false);
        expect(yield* fileSystem.realPath(cursorDestination)).toBe(
          yield* fileSystem.realPath(path.join(fixture.sourceDirectory, "skills", "valid")),
        );
      }),
    ),
  );

  cliIt.effect("classifies a physical collision as partial and delivers neither twin", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const privateSource = path.resolve(fixture.stateDirectory, "..", "private-source");
        const privateSkill = path.join(privateSource, "skills", "valid");
        yield* fileSystem.makeDirectory(privateSkill, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(privateSource, "tack.yaml"),
          "version: 1\nskills:\n  - path: skills\n",
        );
        yield* fileSystem.writeFileString(
          path.join(privateSkill, "SKILL.md"),
          "---\nname: valid\ndescription: Private valid skill\n---\n",
        );

        for (const args of [
          ["state", "init"],
          ["source", "add", fixture.sourceDirectory],
          ["source", "add", privateSource],
          ["adapter", "enable", "cursor"],
          // Both candidates are included: one explicit include would win over the default twin.
          ["pick", "include", "private-source:valid", "--user"],
          ["pick", "include", "source:valid", "--user"],
        ] satisfies ReadonlyArray<ReadonlyArray<string>>) {
          expectSuccess(yield* runTack(sourceEntrypoint, fixture, args));
        }

        const result = yield* runTack(sourceEntrypoint, fixture, ["sync", "--user", "--apply"]);

        expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
        expect(envelope(result)).toMatchObject({
          classification: "partial",
          diagnostics: [expect.objectContaining({ code: "selection-collision" })],
          plan: {
            resources: {
              units: [
                {
                  collisions: [
                    {
                      addresses: [
                        { kind: "skill", name: "valid" },
                        { kind: "skill", name: "valid" },
                      ],
                      name: "valid",
                    },
                  ],
                },
              ],
            },
          },
        });
        expect(
          yield* fileSystem.exists(path.join(fixture.homeDirectory, ".cursor", "skills", "valid")),
        ).toBe(false);
      }),
    ),
  );

  cliIt.effect("isolates one conflict across every root and adapter unit", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (const args of [
          ["init"],
          ["config", "user.email", "tack@example.test"],
          ["config", "user.name", "Tack Test"],
        ] satisfies ReadonlyArray<ReadonlyArray<string>>) {
          expectProcessSuccess(yield* runGit(fixture.repositoryDirectory, args));
        }
        yield* fileSystem.writeFileString(
          path.join(fixture.repositoryDirectory, "README.md"),
          "isolation\n",
        );
        expectProcessSuccess(yield* runGit(fixture.repositoryDirectory, ["add", "README.md"]));
        expectProcessSuccess(
          yield* runGit(fixture.repositoryDirectory, ["commit", "-m", "isolation"]),
        );
        expectProcessSuccess(
          yield* runGit(fixture.repositoryDirectory, [
            "worktree",
            "add",
            "-b",
            "isolation-worktree",
            fixture.worktreeDirectory,
          ]),
        );
        for (const args of [
          ["state", "init"],
          ["source", "add", fixture.sourceDirectory],
          ["project", "add", "workspace", "--repository-cwd", fixture.repositoryDirectory],
          ["adapter", "enable", "codex", "cursor"],
          // The skill is a default for the user too; out of the user's folders, the project links it.
          ["pick", "exclude", "source:valid", "--user"],
        ] satisfies ReadonlyArray<ReadonlyArray<string>>) {
          expectSuccess(yield* runTack(sourceEntrypoint, fixture, args));
        }
        const conflictingDestination = path.join(
          fixture.repositoryDirectory,
          ".agents",
          "skills",
          "valid",
        );
        yield* fileSystem.makeDirectory(path.dirname(conflictingDestination), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(conflictingDestination, "operator-owned\n");

        const result = yield* runTack(sourceEntrypoint, fixture, [
          "sync",
          "--project",
          "workspace",
          "--apply",
        ]);

        expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
        const output = envelope(result);
        expect(output).toMatchObject({
          classification: "partial",
          diagnostics: [expect.objectContaining({ code: "foreign-destination" })],
        });
        const combinedPlan = Schema.decodeUnknownSync(SyncPlanSchema)(output.plan);
        const plan = Schema.decodeUnknownSync(ReconciliationPlanSchema)(combinedPlan.resources);
        const combinedApplication = Schema.decodeUnknownSync(SyncApplicationSchema)(output.applied);
        const application = Schema.decodeUnknownSync(ReconciliationApplyResultSchema)(
          combinedApplication.resources,
        );
        expect(plan.units).toHaveLength(4);
        expect(plan.units.filter((unit) => unit.conflicts.length > 0)).toHaveLength(1);
        expect(application.units.filter((unit) => unit.status === "partial")).toHaveLength(1);
        expect(application.units.filter((unit) => unit.status === "success")).toHaveLength(3);
        expect(yield* fileSystem.readFileString(conflictingDestination)).toBe("operator-owned\n");
        for (const destination of [
          path.join(fixture.repositoryDirectory, ".cursor", "skills", "valid"),
          path.join(fixture.worktreeDirectory, ".agents", "skills", "valid"),
          path.join(fixture.worktreeDirectory, ".cursor", "skills", "valid"),
        ]) {
          expect(path.isAbsolute(yield* fileSystem.readLink(destination))).toBe(false);
          expect(yield* fileSystem.realPath(destination)).toBe(
            yield* fileSystem.realPath(path.join(fixture.sourceDirectory, "skills", "valid")),
          );
        }
      }),
    ),
  );

  cliIt.effect("reports a held state lock without changing bytes at the process boundary", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const holderEntrypoint = path.join(
          repositoryRoot,
          "apps/cli/test/fixtures/hold-state-lock.ts",
        );
        const statePath = path.join(fixture.stateDirectory, "state.json");
        expectSuccess(yield* runTack(sourceEntrypoint, fixture, ["state", "init"]));
        const stateBefore = yield* fileSystem.readFileString(statePath);
        const holder = yield* ChildProcess.make(process.execPath, [holderEntrypoint], {
          cwd: fixture.repositoryDirectory,
          env: tackEnvironment(isolationOf(fixture)),
        });
        const ready = yield* holder.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runHead,
        );

        expect(ready).toMatchObject({ _tag: "Some", value: "ready" });
        const result = yield* runTack(sourceEntrypoint, fixture, [
          "source",
          "add",
          fixture.sourceDirectory,
        ]);
        yield* holder.kill();

        expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
        expect(result.stderr).toBe("");
        expect(envelope(result)).toMatchObject({
          classification: "domain",
          diagnostics: [
            expect.objectContaining({
              code: "state-busy",
              message: expect.stringContaining(path.join(fixture.stateDirectory, "state.lock")),
            }),
          ],
          status: "failure",
        });
        expect(yield* fileSystem.readFileString(statePath)).toBe(stateBefore);
      }),
    ),
  );

  cliIt.effect("takes over a state lock after its writer is killed", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const holderEntrypoint = path.join(
          repositoryRoot,
          "apps/cli/test/fixtures/hold-state-lock.ts",
        );
        const lockPath = path.join(fixture.stateDirectory, "state.lock");
        const statePath = path.join(fixture.stateDirectory, "state.json");
        const temporaryPath = `${statePath}.tmp-orphan`;
        const backupPath = path.join(fixture.stateDirectory, "state.json.v1-backup.keep.json");
        const historyPath = path.join(fixture.stateDirectory, "history");
        expectSuccess(yield* runTack(sourceEntrypoint, fixture, ["state", "init"]));
        const holder = yield* ChildProcess.make(process.execPath, [holderEntrypoint], {
          cwd: fixture.repositoryDirectory,
          env: tackEnvironment(isolationOf(fixture)),
        });
        const ready = yield* holder.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runHead,
        );
        expect(ready).toMatchObject({ _tag: "Some", value: "ready" });
        expect(yield* fileSystem.exists(lockPath)).toBe(true);
        expect(yield* fileSystem.readFileString(lockPath)).toMatch(/^\d+\n$/);
        expectSuccess(yield* runTack(sourceEntrypoint, fixture, ["catalog"]));
        yield* holder.kill({ killSignal: "SIGKILL" });
        expectSuccess(yield* runTack(sourceEntrypoint, fixture, ["catalog"]));
        expect(yield* fileSystem.exists(lockPath)).toBe(true);
        yield* fileSystem.writeFileString(temporaryPath, "orphan");
        yield* fileSystem.writeFileString(backupPath, "backup");
        yield* fileSystem.makeDirectory(historyPath);
        yield* fileSystem.writeFileString(path.join(historyPath, "entry"), "history");

        const result = yield* runTack(sourceEntrypoint, fixture, ["state", "init"]);

        expectSuccess(result);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
        expect(yield* fileSystem.exists(temporaryPath)).toBe(false);
        expect(yield* fileSystem.readFileString(backupPath)).toBe("backup");
        expect(yield* fileSystem.readFileString(path.join(historyPath, "entry"))).toBe("history");
      }),
    ),
  );

  cliIt.effect("recovers all ten pre- and post-rename SIGKILL points", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crashEntrypoint = path.join(
        repositoryRoot,
        "apps/cli/test/fixtures/crash-state-writes.ts",
      );
      for (const point of ["before-rename", "after-rename"]) {
        for (let write = 1; write <= 5; write += 1) {
          yield* withFixture((fixture) =>
            Effect.gen(function* () {
              const child = yield* ChildProcess.make(process.execPath, [crashEntrypoint], {
                cwd: fixture.repositoryDirectory,
                env: tackEnvironment(isolationOf(fixture), {
                  TACK_TEST_CRASH_AT: String(write),
                  TACK_TEST_CRASH_POINT: point,
                }),
              });
              const crash = yield* Effect.flip(child.exitCode);
              expect(crash, `${point} write ${write}`).toMatchObject({
                reason: {
                  cause: expect.objectContaining({ message: expect.stringContaining("SIGKILL") }),
                },
              });
              expect(
                yield* fileSystem.exists(path.join(fixture.stateDirectory, "state.lock")),
              ).toBe(true);
              const recovered = yield* runTack(sourceEntrypoint, fixture, ["state", "init"]);
              expect(recovered.exitCode, `${point} write ${write}: ${recovered.stdout}`).toBe(
                ChildProcessSpawner.ExitCode(0),
              );
              expect(
                yield* fileSystem.exists(path.join(fixture.stateDirectory, "state.lock")),
              ).toBe(false);
              expect(
                (yield* fileSystem.readDirectory(fixture.stateDirectory)).filter((entry) =>
                  entry.startsWith("state.json.tmp-"),
                ),
              ).toEqual([]);
            }),
          );
        }
      }
    }),
  );

  cliIt.effect("emits deterministic format 1 command envelopes", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixtureRoot = path.dirname(fixture.homeDirectory);
        const captures: Array<{ command: string; stdout: string }> = [];
        const capture = (command: ReadonlyArray<string>, stdout: string) => {
          captures.push({
            command: command.join(" ").replaceAll(fixtureRoot, "<FIXTURE>"),
            stdout: stdout
              .replaceAll(fixtureRoot, "<FIXTURE>")
              .replaceAll(repositoryRoot, "<REPOSITORY>")
              .replace(/(?:\.\.\/)*\.\.<REPOSITORY>/g, "<REPOSITORY-RELATIVE>")
              .replaceAll(
                /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
                "<UUID>",
              ),
          });
        };
        for (const command of [
          ["state", "init"],
          ["source", "add", fixture.sourceDirectory],
          ["adapter", "enable", "codex"],
          ["sync", "--user"],
          ["sync", "--user", "--apply"],
          ["status", "--user"],
        ]) {
          const result = yield* runTack(sourceEntrypoint, fixture, command);
          expectSuccess(result);
          capture(command, result.stdout);
        }
        yield* fileSystem.remove(path.join(fixture.homeDirectory, ".agents", "skills", "valid"));
        const driftCommand = ["status", "--user"];
        const drift = yield* runTack(sourceEntrypoint, fixture, driftCommand);
        expect(drift.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
        expect(envelope(drift).status).toBe("partial");
        capture(driftCommand, drift.stdout);
        const resetCommand = ["state", "reset", "--apply"];
        const reset = yield* runTack(sourceEntrypoint, fixture, resetCommand);
        expectSuccess(reset);
        capture(resetCommand, reset.stdout);

        expect(captures).toHaveLength(8);
        expect(captures[0]?.stdout).toContain('"command":"state init"');
        expect(captures[4]?.stdout).toContain('"kind":"sync-application"');
      }),
    ),
  );

  cliIt.effect(
    "keeps source and built catalogs equivalent apart from installation-relative asset paths",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          expectSuccess(yield* runTack(sourceEntrypoint, fixture, ["state", "init"]));

          const sourceCatalog = yield* runTack(sourceEntrypoint, fixture, ["catalog"]);
          const builtCatalog = yield* runTack(builtEntrypoint, fixture, ["catalog"]);

          expectSuccess(sourceCatalog);
          expectSuccess(builtCatalog);
          expect(builtCatalog.stdout).toBe(
            sourceCatalog.stdout.replaceAll(
              path.resolve("apps/cli/src/builtins"),
              path.resolve("apps/cli/dist/builtins"),
            ),
          );
          const fs = yield* FileSystem.FileSystem;
          const installed = path.join(
            path.dirname(fixture.repositoryDirectory),
            "installed release",
          );
          const installedEntrypoint = path.join(installed, "main.js");
          yield* fs.makeDirectory(installed);
          yield* fs.copyFile(builtEntrypoint, installedEntrypoint);
          yield* fs.copy(path.resolve("apps/cli/dist/builtins"), path.join(installed, "builtins"));
          // Reader dependencies remain external; this test verifies bundled resource relocation.
          yield* fs.symlink(
            path.resolve("apps/cli/node_modules"),
            path.join(installed, "node_modules"),
          );
          const installedCatalog = yield* runTack(installedEntrypoint, fixture, ["catalog"]);
          expectSuccess(installedCatalog);
          expect(installedCatalog.stdout).toBe(
            builtCatalog.stdout.replaceAll(
              path.resolve("apps/cli/dist/builtins"),
              path.join(installed, "builtins"),
            ),
          );
          expectSuccess(
            yield* runTack(installedEntrypoint, fixture, ["adapter", "enable", "codex"]),
          );
          expectSuccess(
            yield* runTack(installedEntrypoint, fixture, ["sync", "--user", "--apply"]),
          );
          const destination = path.join(fixture.homeDirectory, ".agents/skills/use-tack");
          expect(yield* fs.realPath(destination)).toBe(
            path.join(installed, "builtins/skills/use-tack"),
          );
          // Retain the old release until its managed links have been verified and replaced.
          const upgraded = `${installed} next`;
          yield* fs.copy(installed, upgraded);
          const upgradedEntrypoint = path.join(upgraded, "main.js");
          expectSuccess(yield* runTack(upgradedEntrypoint, fixture, ["sync", "--user", "--apply"]));
          expect(yield* fs.realPath(destination)).toBe(
            path.join(upgraded, "builtins/skills/use-tack"),
          );
          yield* fs.rename(path.join(upgraded, "builtins"), path.join(upgraded, "unavailable"));
          const unavailable = yield* runTack(upgradedEntrypoint, fixture, ["catalog"]);
          expect(unavailable.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
          expect(envelope(unavailable).result).toMatchObject({
            complete: false,
            issues: [{ code: "source-missing", subject: { _tag: "source", origin: "builtin" } }],
          });
          yield* fs.rename(path.join(upgraded, "unavailable"), path.join(upgraded, "builtins"));
          expectSuccess(yield* runTack(upgradedEntrypoint, fixture, ["catalog"]));
        }),
      ),
  );

  cliIt.effect("does not require HOME when an explicit state directory makes it irrelevant", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const withoutHome = (arguments_: ReadonlyArray<string>) =>
          tackProcess(["--json", "--state-dir", fixture.stateDirectory, ...arguments_], {
            cwd: fixture.repositoryDirectory,
          });
        const result = yield* withoutHome(["state", "init"]);
        const choices = yield* withoutHome(["pick", "--user"]);
        const userStatus = yield* withoutHome(["status", "--user"]);

        expectSuccess(result);
        expectSuccess(choices);
        // The user target is the operator home, so a selector that reaches it still needs HOME.
        expect(userStatus.exitCode).toBe(ChildProcessSpawner.ExitCode(2));
        expect(envelope(userStatus)).toMatchObject({
          classification: "invalid-configuration",
          command: "status",
          diagnostics: [{ code: "home-directory-unavailable" }],
        });
      }),
    ),
  );
  cliIt.effect(
    "reports one mixed catalog through catalog and status while reconciling supported skills",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const write = writeUnder(fixture.sourceDirectory);
          yield* write("commands/review.md", "# Review");
          yield* write("context/notes.md", "Context");
          yield* write(
            "tack.yaml",
            "version: 1\nskills:\n  - path: skills\ncommands:\n  - path: commands\ncontext:\n  - path: context\nscripts:\n  - name: broken\n    path: scripts/broken.ts\n    description: Listed without executable validation\n",
          );
          yield* write("scripts/broken.ts", "this is deliberately invalid TypeScript !!!");
          yield* write(
            "skills/personal/SKILL.md",
            "---\nname: personal\ndescription: Personal\n---\n",
          );
          yield* write(
            "skills/blocked/SKILL.md",
            "---\nname: blocked\ndescription: Blocked\nmetadata:\n  tack: |\n    version: 1\n    dependencies:\n      - source: source\n        kind: command\n        name: review\n---\n",
          );
          for (const args of [
            ["state", "init"],
            ["source", "add", fixture.sourceDirectory],
            ["adapter", "enable", "cursor"],
            ["pick", "include", "personal", "--user"],
            ["pick", "include", "blocked", "--user"],
          ]) {
            expectSuccess(yield* runTack(sourceEntrypoint, fixture, args));
          }
          const catalog = envelope(yield* runTack(sourceEntrypoint, fixture, ["catalog"]));
          const status = envelope(yield* runTack(sourceEntrypoint, fixture, ["status", "--user"]));
          const decodeReport = Schema.decodeUnknownSync(CatalogReportSchema, {
            onExcessProperty: "error",
          });
          const facts = decodeReport(catalog.result);
          expect(facts.resources.map((resource) => resource.kind).sort()).toEqual([
            "command",
            "context",
            "script",
            "skill",
            "skill",
            "skill",
            "skill",
            "skill",
            "skill",
            "skill",
            "skill",
          ]);
          expect(facts.resources.some((resource) => "frontmatter" in resource)).toBe(false);
          // Status counts what `catalog` lists: it no longer carries a copy of the catalog.
          expect(status).toMatchObject({
            result: {
              catalog: {
                quarantined: facts.issues.filter(({ subject }) => subject["_tag"] === "resource")
                  .length,
                resources: facts.resources.length,
                unavailable: facts.issues.filter(({ subject }) => subject["_tag"] !== "resource")
                  .length,
              },
            },
          });
          const detailed = decodeReport(
            envelope(yield* runTack(sourceEntrypoint, fixture, ["catalog", "--details"])).result,
          );
          expect(
            detailed.resources.map((resource) => {
              const {
                frontmatter: _,
                declaredPath: declared,
                ...concise
              } = { frontmatter: undefined, declaredPath: undefined, ...resource };
              expect(declared, resource.address.name).toBeTypeOf("string");
              return concise;
            }),
          ).toEqual(
            facts.resources.map((resource) => {
              const { declaredPath: _declared, ...concise } = {
                declaredPath: undefined,
                ...resource,
              };
              return concise;
            }),
          );
          expect(
            detailed.resources.find((resource) => resource.address.name === "blocked"),
          ).toMatchObject({
            frontmatter: { metadata: { tack: expect.stringContaining("dependencies:") } },
          });
          const scripts = decodeReport(
            envelope(yield* runTack(sourceEntrypoint, fixture, ["catalog", "--kind", "script"]))
              .result,
          );
          expect(scripts).toMatchObject({
            complete: true,
            resources: [{ kind: "script", address: { name: "broken" } }],
            scope: "script",
          });
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const before = yield* fs.readFileString(statePath);
          for (const kind of ["script"]) {
            const rejected = yield* runTack(sourceEntrypoint, fixture, [
              "pick",
              "include",
              "review",
              "--kind",
              kind,
              "--user",
            ]);
            expect(rejected.exitCode).toBe(ChildProcessSpawner.ExitCode(2));
            expect(yield* fs.readFileString(statePath)).toBe(before);
          }
          const reconciled = envelope(
            yield* runTack(sourceEntrypoint, fixture, ["sync", "--user", "--apply"]),
          );
          expect(reconciled).toMatchObject({ classification: "success" });
          const destination = path.join(fixture.homeDirectory, ".cursor", "skills");
          expect(yield* fs.realPath(path.join(destination, "valid"))).toBe(
            path.join(fixture.sourceDirectory, "skills", "valid"),
          );
          expect(yield* fs.realPath(path.join(destination, "personal"))).toBe(
            path.join(fixture.sourceDirectory, "skills", "personal"),
          );
          expect(yield* fs.exists(path.join(destination, "blocked"))).toBe(true);
          expect(
            yield* fs.realPath(
              path.join(fixture.homeDirectory, ".cursor", "commands", "review.md"),
            ),
          ).toBe(path.join(fixture.sourceDirectory, "commands", "review.md"));
          expectSuccess(
            yield* runTack(sourceEntrypoint, fixture, ["pick", "include", "notes.md", "--user"]),
          );
          const selectedContext = envelope(
            yield* runTack(sourceEntrypoint, fixture, ["status", "--user"]),
          );
          expect(selectedContext).toMatchObject({
            result: {
              namespaces: [
                {
                  undelivered: [
                    {
                      address: { kind: "context", name: "notes.md" },
                      reason: "context-not-delivered",
                    },
                  ],
                },
              ],
            },
          });
          expectSuccess(
            yield* runTack(sourceEntrypoint, fixture, ["pick", "exclude", "review", "--user"]),
          );
          const excluded = envelope(
            yield* runTack(sourceEntrypoint, fixture, ["sync", "--user", "--apply"]),
          );
          expect(excluded).toMatchObject({ classification: "partial" });
          expect(
            yield* fs.exists(path.join(fixture.homeDirectory, ".cursor", "commands", "review.md")),
          ).toBe(false);
        }),
      ),
  );
  cliIt.effect(
    "refuses flat version 2 state before initialization, inspection, mutation, and reset without losing evidence",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(fixture.stateDirectory, { recursive: true });
          const statePath = path.join(fixture.stateDirectory, "state.json");
          const target = path.join(fixture.sourceDirectory, "skills", "valid");
          const destination = path.join(fixture.homeDirectory, ".cursor", "skills", "valid");
          yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
          yield* fs.symlink(path.relative(path.dirname(destination), target), destination);
          const encoded = JSON.stringify({
            version: 99,
            data: {
              sources: [
                {
                  canonicalPath: fixture.sourceDirectory,
                  id: "00000000-0000-4000-8000-000000000001",
                },
              ],
              managedLinks: [
                {
                  adapter: "cursor",
                  address: { kind: "skill", name: "valid" },
                  sourceDirectoryPath: target,
                  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
                  target: { _tag: "user", canonicalPath: fixture.homeDirectory },
                },
              ],
            },
          });
          yield* fs.writeFileString(statePath, encoded);
          for (const args of [
            ["state", "init"],
            ["catalog"],
            ["source", "add", fixture.sourceDirectory],
            ["state", "reset", "--apply"],
          ]) {
            const result = yield* runTack(sourceEntrypoint, fixture, args);
            expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(3));
            expect(envelope(result)).toMatchObject({ classification: "persistence" });
            expect(yield* fs.readFileString(statePath)).toBe(encoded);
            expect(yield* fs.realPath(destination)).toBe(target);
            expect(yield* fs.exists(path.join(fixture.stateDirectory, ".env"))).toBe(false);
          }
        }),
      ),
  );
});
