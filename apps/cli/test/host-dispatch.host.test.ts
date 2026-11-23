import { mutateState } from "./support/state-fixture.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError, Predicate, Schema } from "effect";
import { GitCommandError, type GitService } from "../src/services/git.ts";
import { validatePublicEnvelope } from "../src/cli/host/run.ts";
import { exitCodeForEnvelope } from "../src/cli/host/public-outcome.ts";
import { type TerminalContextShape } from "../src/cli/host/human/terminal-context.ts";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";
import { ExecutionPlatform } from "../src/services/execution-platform.ts";
import { makeRunCancellation } from "../src/platform/execution/execution-platform.ts";
import { initializeState, readState, type StateOptions } from "../src/services/state-store.ts";

it.effect("redacts malformed host envelopes before they reach stdout", () =>
  Effect.gen(function* () {
    const envelope = yield* validatePublicEnvelope({
      classification: "success",
      command: "adapter enable",
      diagnostics: [{ code: "unsafe", message: "secret", severity: "invalid" }],
      version: 1,
    });
    for (const candidate of [undefined, { command: "unsafe" }, { command: "adapter-set" }])
      expect(yield* validatePublicEnvelope(candidate)).toMatchObject({
        classification: "internal",
        command: "unknown",
      });

    expect(envelope).toEqual({
      applied: null,
      classification: "internal",
      command: "adapter enable",
      diagnostics: [
        {
          code: "internal-error",
          message: "An unexpected internal error occurred.",
          severity: "error",
        },
      ],
      next: [],
      plan: null,
      result: null,
      status: "failure",
      version: 1,
    });
  }),
);

const testGit = (anchor: string, root: string) =>
  ({
    listWorktrees: () => Effect.succeed([{ bare: false, detached: false, path: root }]),
    resolveCommonDirectory: () => Effect.succeed(anchor),
  }) satisfies GitService;

const runHostRaw = (
  args: ReadonlyArray<string>,
  git: GitService,
  fileSystemOverride?: FileSystem.FileSystem,
  terminal?: TerminalContextShape,
) => {
  const run = runHost({ args, git, ...(terminal === undefined ? {} : { terminal }) });
  return fileSystemOverride === undefined
    ? run
    : run.pipe(Effect.provideService(FileSystem.FileSystem, fileSystemOverride));
};

const runJson = (
  arguments_: ReadonlyArray<string>,
  git: GitService,
  fileSystemOverride?: FileSystem.FileSystem,
  terminal?: TerminalContextShape,
) => runHostRaw(["--json", ...arguments_], git, fileSystemOverride, terminal);

const envelopeFrom = (result: { readonly stdout: string }) => decodeEnvelope(result.stdout);

it.layer(LiveTestLayer)("CLI host dispatch", (hostIt) => {
  hostIt.effect(
    "shows source labels and maintainers in source and catalog output without changing addresses",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "tack-source-label-host-" });
        const stateDirectory = path.join(root, "state");
        const source = path.join(root, "personal-brain");
        yield* fs.makeDirectory(path.join(source, "skills", "review"), { recursive: true });
        yield* fs.writeFileString(
          path.join(source, "tack.yaml"),
          "version: 1\nname: personal-brain\nmaintainers: [platform team, ada]\nskills:\n  - path: skills\n",
        );
        yield* fs.writeFileString(
          path.join(source, "skills", "review", "SKILL.md"),
          "---\nname: review\ndescription: Review\n---\n",
        );
        const git = testGit(root, root);
        const args = (command: string) => ["--state-dir", stateDirectory, command];
        yield* runJson(args("state").concat("init"), git);
        yield* runJson(args("source").concat("add", source), git);
        const sourceOutput = envelopeFrom(yield* runJson(args("source"), git));
        const catalogOutput = envelopeFrom(yield* runJson(args("catalog"), git));
        const sourceHuman = (yield* runHostRaw(args("source"), git)).stdout;
        const catalogHuman = (yield* runHostRaw(args("catalog"), git)).stdout;
        expect(sourceOutput.result).toMatchObject({
          sources: [
            {
              label: "personal-brain",
              labelOrigin: "declared",
              maintainers: ["platform team", "ada"],
            },
          ],
        });
        expect(catalogOutput.result).toMatchObject({
          sources: [{ label: "personal-brain", maintainers: ["platform team", "ada"] }],
          resources: [{ address: { kind: "skill", name: "review" } }],
        });
        expect(sourceHuman).toContain("personal-brain (declared)");
        expect(sourceHuman).toContain("platform team, ada");
        expect(catalogHuman).toContain("review  personal-brain");
        expect(catalogHuman.match(/maintainers/g)).toHaveLength(1);
        expect(
          (yield* readState({
            environment: { TACK_STATE_DIR: stateDirectory },
            homeDirectory: root,
          })).format,
        ).toBe(1);
      }),
  );

  hostIt.effect("dispatches every core use case without a command-owned runtime", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-host-test-" });
      const stateDirectory = path.join(root, "state");
      const anchor = path.join(root, "anchor");
      const projectRoot = path.join(root, "project");
      const source = path.join(root, "source");
      const relocatedSource = path.join(root, "relocated-source");
      const outside = path.join(root, "outside");
      yield* Effect.forEach([anchor, projectRoot, source, relocatedSource, outside], (directory) =>
        fileSystem.makeDirectory(directory, { recursive: true }),
      );
      for (const sourceDirectory of [source, relocatedSource]) {
        yield* fileSystem.writeFileString(
          path.join(sourceDirectory, "tack.yaml"),
          "version: 1\nskills:\n  - path: skills\n",
        );
      }
      yield* fileSystem.makeDirectory(path.join(relocatedSource, "skills", "valid"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(relocatedSource, "skills", "valid", "SKILL.md"),
        "---\nname: valid\ndescription: Valid\n---\n",
      );
      const git = testGit(
        yield* fileSystem.realPath(anchor),
        yield* fileSystem.realPath(projectRoot),
      );
      const invocation = (arguments_: ReadonlyArray<string>) =>
        runJson(["--state-dir", stateDirectory, ...arguments_], git);

      const initialized = yield* invocation(["state", "init"]);
      const registered = yield* invocation(["source", "add", source]);
      const appliedRegistration = envelopeFrom(registered).applied;
      expect(envelopeFrom(registered)).toMatchObject({ classification: "success" });
      if (
        !Predicate.isObject(appliedRegistration) ||
        !Predicate.isObject(appliedRegistration["registration"]) ||
        typeof appliedRegistration["registration"]["id"] !== "string"
      ) {
        return yield* Effect.die("source registration was not returned by the host");
      }
      const relocated = yield* invocation([
        "source",
        "relocate",
        appliedRegistration["registration"]["id"],
        relocatedSource,
      ]);
      const sourceInspection = yield* invocation(["source"]);
      const project = yield* invocation([
        "project",
        "add",
        "workspace",
        "--repository-cwd",
        projectRoot,
      ]);
      const projectInspection = yield* invocation(["project"]);
      const catalog = yield* invocation(["catalog"]);
      const plan = yield* invocation(["sync", "--project", "workspace"]);
      const adapterSet = yield* invocation(["adapter", "enable", "cursor", "codex"]);
      const adapterList = yield* invocation(["adapter", "list"]);
      const choiceSet = yield* invocation(["pick", "include", "valid", "--project", "workspace"]);
      const choiceList = yield* invocation(["pick", "--project", "workspace"]);
      const planning = [
        "--project",
        "workspace",
        "--adapter",
        "cursor",
        "--require-capability",
        "skill-links",
      ];
      const dryReconcile = yield* invocation(["sync", ...planning]);
      const samePlan = yield* invocation(["sync", ...planning]);
      const rejectedPlanApply = yield* invocation([
        "sync",
        ...planning,
        "--no-adapters",
        "--apply",
      ]);
      const appliedReconcile = yield* invocation(["sync", "--project", "workspace", "--apply"]);
      const choiceRemove = yield* invocation(["pick", "remove", "valid", "--project", "workspace"]);

      expect(envelopeFrom(initialized)).toMatchObject({ applied: { kind: "initialization" } });
      expect(envelopeFrom(registered)).toMatchObject({
        applied: { kind: "source-registration", alreadyRegistered: false },
      });
      expect(envelopeFrom(relocated)).toMatchObject({
        applied: { kind: "source-registration", relocated: true },
      });
      expect(envelopeFrom(project)).toMatchObject({
        applied: { kind: "project-registration", alreadyRegistered: false },
      });
      for (const result of [
        initialized,
        registered,
        relocated,
        sourceInspection,
        project,
        projectInspection,
        catalog,
        adapterSet,
        adapterList,
        choiceSet,
        choiceList,
        dryReconcile,
        samePlan,
        appliedReconcile,
        choiceRemove,
      ]) {
        expect(envelopeFrom(result)).toMatchObject({
          classification: "success",
          status: "success",
        });
      }
      // No adapter is enabled yet, so the plan delivers nothing that the selection asks for.
      expect(envelopeFrom(plan)).toMatchObject({
        applied: null,
        classification: "partial",
        command: "sync",
        diagnostics: [{ code: "no-adapters-enabled" }],
        plan: { kind: "sync-plan", resources: { kind: "skill-reconciliation-plan", units: [] } },
        result: null,
      });
      expect({ ...envelopeFrom(samePlan), command: "sync" }).toEqual(envelopeFrom(dryReconcile));
      expect(envelopeFrom(samePlan)).toMatchObject({ applied: null, command: "sync" });
      expect(envelopeFrom(rejectedPlanApply)).toMatchObject({
        classification: "invalid-invocation",
        command: "sync",
        diagnostics: [{ code: "invalid-flag" }],
      });
      expect(envelopeFrom(rejectedPlanApply).diagnostics[0]).not.toHaveProperty("details");
      expect(envelopeFrom(adapterSet)).toMatchObject({
        applied: { kind: "adapter-settings", changed: true, enabledAdapters: ["codex", "cursor"] },
        command: "adapter enable",
        plan: null,
        result: null,
      });
      expect(envelopeFrom(adapterList)).toMatchObject({
        applied: null,
        command: "adapter",
        plan: null,
        result: { kind: "adapters", enabledAdapters: ["codex", "cursor"] },
      });
      expect(envelopeFrom(choiceSet)).toMatchObject({
        applied: { kind: "choice-change", changed: true, choice: { address: { name: "valid" } } },
        command: "pick include",
        plan: null,
        result: null,
      });
      expect(envelopeFrom(choiceList)).toMatchObject({
        applied: null,
        command: "pick",
        plan: null,
        result: { kind: "choices", choices: [{ address: { name: "valid" }, decision: "include" }] },
      });
      expect(envelopeFrom(dryReconcile)).toMatchObject({
        applied: null,
        command: "sync",
        plan: {
          kind: "sync-plan",
          resources: { kind: "skill-reconciliation-plan", units: [{ adapter: "cursor" }] },
        },
        result: null,
      });
      expect(envelopeFrom(appliedReconcile)).toMatchObject({
        applied: {
          kind: "sync-application",
          resources: { kind: "skill-reconciliation-application", units: expect.any(Array) },
        },
        command: "sync",
        plan: {
          kind: "sync-plan",
          resources: { kind: "skill-reconciliation-plan", units: expect.any(Array) },
        },
        result: null,
      });
      expect(envelopeFrom(choiceRemove)).toMatchObject({
        applied: { kind: "choice-removal", removed: true },
        command: "pick remove",
      });
      expect(
        yield* fileSystem.readLink(path.join(projectRoot, ".agents", "skills", "valid")),
      ).not.toMatch(/^\//);
      expect(
        yield* fileSystem.readLink(path.join(projectRoot, ".cursor", "skills", "valid")),
      ).not.toMatch(/^\//);
      yield* fileSystem.writeFileString(path.join(relocatedSource, "tack.yaml"), "version: 99\n");
      expect(envelopeFrom(yield* invocation(["source"]))).toMatchObject({
        classification: "partial",
        diagnostics: [
          {
            code: "source-unhealthy",
            details: {
              subject: {
                issue: { code: "declaration-version-unsupported" },
                registration: { canonicalPath: expect.stringMatching(/relocated-source$/) },
              },
            },
          },
        ],
        result: {
          kind: "source-inspections",
          sources: [{ status: "unhealthy", issue: { code: "declaration-version-unsupported" } }],
        },
      });
      return undefined;
    }),
  );

  hostIt.effect("blocks only adapters that cannot deliver the required capability", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-host-test-" });
      const stateDirectory = path.join(root, "state");
      const anchor = path.join(root, "anchor");
      const projectRoot = path.join(root, "project");
      const source = path.join(root, "source");
      yield* Effect.forEach([anchor, projectRoot, path.join(source, "commands")], (directory) =>
        fileSystem.makeDirectory(directory, { recursive: true }),
      );
      yield* fileSystem.writeFileString(
        path.join(source, "tack.yaml"),
        "version: 1\ncommands:\n  - path: commands\n",
      );
      yield* fileSystem.writeFileString(path.join(source, "commands", "review.md"), "# Review\n");
      const git = testGit(
        yield* fileSystem.realPath(anchor),
        yield* fileSystem.realPath(projectRoot),
      );
      const invoke = (arguments_: ReadonlyArray<string>) =>
        runJson(["--state-dir", stateDirectory, ...arguments_], git);
      for (const setup of [
        ["state", "init"],
        ["source", "add", source],
        ["project", "add", "workspace", "--repository-cwd", projectRoot],
        ["adapter", "enable", "claude", "cursor"],
      ])
        expect(envelopeFrom(yield* invoke(setup))).toMatchObject({ status: "success" });
      const requireCommandLinks = (adapter: string) =>
        invoke([
          "sync",
          "--project",
          "workspace",
          "--adapter",
          adapter,
          "--require-capability",
          "command-links",
        ]);

      expect(envelopeFrom(yield* requireCommandLinks("claude"))).toMatchObject({
        classification: "partial",
        command: "sync",
        plan: {
          resources: {
            namespaceResolutions: [
              {
                resolution: {
                  groups: [
                    {
                      _tag: "selected",
                      members: [{ kind: "command", name: "review" }],
                    },
                  ],
                },
              },
            ],
            units: [
              {
                actions: [],
                adapter: "claude",
                capability: { _tag: "blocked", capability: "command-links" },
                delivery: { command: "unsupported", skill: "delivered" },
              },
            ],
          },
        },
      });
      expect(envelopeFrom(yield* requireCommandLinks("cursor"))).toMatchObject({
        classification: "success",
        plan: {
          resources: {
            units: [
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
            ],
          },
        },
      });
    }),
  );

  hostIt.effect("dispatches every docs operation to its own workflow", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-host-test-" });
      const stateDirectory = path.join(root, "state");
      const anchor = path.join(root, "anchor");
      const projectRoot = path.join(root, "project");
      const source = path.join(root, "source");
      yield* Effect.forEach([anchor, projectRoot, path.join(source, "knowledge")], (directory) =>
        fileSystem.makeDirectory(directory, { recursive: true }),
      );
      yield* fileSystem.writeFileString(
        path.join(source, "tack.yaml"),
        "version: 1\ndocs:\n  - name: handbook\n    path: knowledge\n",
      );
      yield* fileSystem.writeFileString(path.join(source, "knowledge", "guide.md"), "# Guide\n");
      const canonicalProjectRoot = yield* fileSystem.realPath(projectRoot);
      const git = testGit(yield* fileSystem.realPath(anchor), canonicalProjectRoot);
      const invoke = (arguments_: ReadonlyArray<string>) =>
        runJson(["--state-dir", stateDirectory, ...arguments_], git).pipe(Effect.map(envelopeFrom));
      expect(yield* invoke(["state", "init"])).toMatchObject({ status: "success" });
      const added = (yield* invoke(["source", "add", source])).applied;
      expect(added).toMatchObject({ docs: [{ name: "handbook" }] });
      const sourceId = Schema.decodeUnknownSync(
        Schema.Struct({ registration: Schema.Struct({ id: Schema.String }) }),
      )(added).registration.id;
      expect(
        yield* invoke(["project", "add", "workspace", "--repository-cwd", projectRoot]),
      ).toMatchObject({ status: "success" });
      const resource = { name: "handbook", sourceRegistrationId: sourceId };
      const selectResource = [`${sourceId}:handbook`, "--project", "workspace"];

      const docsTarget = path.join(canonicalProjectRoot, ".tack", "docs", sourceId, "handbook");

      expect(yield* invoke(["docs", "attach", "handbook", "--project", "workspace"])).toMatchObject(
        {
          applied: { kind: "docs-settings", attachments: [resource], projectName: "workspace" },
          command: "docs attach",
          plan: null,
          result: null,
          status: "success",
        },
      );
      expect(
        yield* invoke([
          "docs",
          "configure",
          "--cwd",
          projectRoot,
          "--default",
          `${sourceId}:handbook`,
        ]),
      ).toMatchObject({
        applied: {
          kind: "docs-settings",
          defaultWritingResource: resource,
          projectName: "workspace",
        },
        command: "docs configure",
        status: "success",
      });
      expect(yield* invoke(["sync", "--no-adapters", "--cwd", projectRoot])).toMatchObject({
        applied: null,
        classification: "success",
        command: "sync",
        plan: { kind: "sync-plan", docs: [{ actions: [{ action: "create" }], complete: true }] },
      });
      expect(
        yield* invoke(["sync", "--no-adapters", "--project", "workspace", "--apply"]),
      ).toMatchObject({
        applied: {
          kind: "sync-application",
          docs: [{ actions: [{ _tag: "applied", action: { action: "create" } }], complete: true }],
        },
        command: "sync",
        plan: { kind: "sync-plan", docs: [{ actions: [{ action: "create" }], complete: true }] },
      });
      const listed = yield* invoke(["docs", "list", "--project", "workspace"]);
      expect(listed).toMatchObject({
        classification: "success",
        command: "docs",
        result: {
          kind: "docs-list",
          complete: true,
          issues: [],
          project: { name: "workspace", root: canonicalProjectRoot },
          resources: [{ name: "handbook", sourceRegistrationId: sourceId }],
          settings: { defaultWritingResource: resource },
        },
        status: "success",
      });
      expect(
        Object.keys(
          Schema.decodeUnknownSync(
            Schema.Struct({ result: Schema.Record(Schema.String, Schema.Unknown) }),
          )(listed).result,
        ).sort(),
      ).toEqual([
        "complete",
        "documents",
        "issues",
        "kind",
        "mounts",
        "project",
        "resources",
        "settings",
      ]);
      expect(
        Schema.decodeUnknownSync(
          Schema.Struct({
            result: Schema.Struct({ settings: Schema.Record(Schema.String, Schema.Unknown) }),
          }),
        )(listed).result.settings,
      ).toEqual({ defaultWritingResource: resource });
      expect(yield* invoke(["docs", "target", "--cwd", projectRoot])).toMatchObject({
        command: "docs target",
        result: {
          kind: "docs-target",
          destinationPath: docsTarget,
          projectName: "workspace",
          resource,
        },
        status: "success",
      });
      expect(yield* invoke(["docs", "detach", ...selectResource])).toMatchObject({
        applied: { kind: "docs-settings", attachments: [], projectName: "workspace" },
        command: "docs detach",
        status: "success",
      });
      const second = path.join(root, "second");
      yield* fileSystem.makeDirectory(path.join(second, "notes"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(second, "tack.yaml"),
        "version: 1\ndocs:\n  - name: handbook\n    path: notes\n",
      );
      const secondAdded = yield* invoke(["source", "add", second]);
      expect(secondAdded).toMatchObject({ status: "success" });
      const secondId = Schema.decodeUnknownSync(
        Schema.Struct({
          applied: Schema.Struct({ registration: Schema.Struct({ id: Schema.String }) }),
        }),
      )(secondAdded).applied.registration.id;
      const ambiguous = yield* invoke(["docs", "attach", "handbook", "--project", "workspace"]);
      expect(ambiguous).toMatchObject({
        classification: "invalid-configuration",
        command: "docs attach",
        diagnostics: [
          {
            code: "docs-resource-ambiguous",
            details: {
              candidates: expect.arrayContaining([
                expect.objectContaining({ sourceRegistrationId: sourceId }),
              ]),
              name: "handbook",
            },
          },
        ],
      });
      expect(
        Schema.decodeUnknownSync(
          Schema.Struct({
            diagnostics: Schema.Tuple([
              Schema.Struct({
                details: Schema.Struct({ candidates: Schema.Array(Schema.Unknown) }),
              }),
            ]),
          }),
        )(ambiguous).diagnostics[0].details.candidates,
      ).toHaveLength(2);
      yield* invoke(["docs", "attach", `${secondId}:handbook`, "--project", "workspace"]);
      yield* fileSystem.remove(path.join(second, "notes"), { recursive: true });
      expect(yield* invoke(["docs", "list", "--project", "workspace"])).toMatchObject({
        classification: "partial",
        diagnostics: [{ code: "docs-partial", severity: "warning" }],
        result: {
          kind: "docs-list",
          complete: false,
          issues: [{ resource: { name: "handbook" } }],
          resources: [],
        },
        status: "partial",
      });
    }),
  );

  hostIt.effect("renders typed failures and parser failures as stable envelope exit effects", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-host-test-" });
      const stateDirectory = path.join(root, "state");
      const git = testGit(path.join(root, "anchor"), path.join(root, "project"));
      const invalidInvocations = [
        {
          arguments: ["docs", "serve", "--port", "nope"],
          code: "invalid-flag",
          command: "docs serve",
          message:
            'Invalid value for flag --port: "nope". Expected: Schema validation failed: Expected an integer',
        },
        {
          arguments: ["source", "add"],
          code: "missing-argument",
          command: "source add",
          message: "Missing required argument: source-path",
        },
        {
          arguments: ["sync", "--project", "workspace", "--user"],
          code: "invalid-selector",
          command: "sync",
          message: "Choose at most one of --project, --user and --all.",
        },
        {
          arguments: ["pick", "include", "review"],
          code: "invalid-selector",
          command: "pick include",
          message: "Choose exactly one namespace with --project or --user.",
        },
        {
          arguments: ["pick", "wibble"],
          code: "invalid-command",
          command: "pick",
          message: 'Unknown subcommand "wibble" for "tack pick"',
        },
        {
          arguments: ["wibble"],
          code: "invalid-command",
          command: "unknown",
          message: 'Unknown subcommand "wibble" for "tack"',
        },
      ] as const;
      for (const invocation of invalidInvocations) {
        const invalid = yield* runJson(
          ["--state-dir", stateDirectory, ...invocation.arguments],
          git,
        );
        expect(envelopeFrom(invalid)).toMatchObject({
          classification: "invalid-invocation",
          command: invocation.command,
          diagnostics: [{ code: invocation.code, message: invocation.message }],
        });
        expect(envelopeFrom(invalid).diagnostics[0]).not.toHaveProperty("details");
      }
      const missingState = yield* runJson(["--state-dir", stateDirectory, "catalog"], git);

      expect(envelopeFrom(missingState)).toMatchObject({
        classification: "invalid-configuration",
        diagnostics: [
          {
            code: "state-not-initialized",
            details: { statePath: path.join(stateDirectory, "state.json") },
            message: `Tack state is absent at ${path.join(stateDirectory, "state.json")}. Run \`tack --state-dir ${stateDirectory} state init\` to initialize this exact directory.`,
          },
        ],
      });
      yield* runJson(["--state-dir", stateDirectory, "state", "init"], git);
      const missingChoiceProject = yield* runJson(
        ["--state-dir", stateDirectory, "pick", "include", "alpha", "--project", "missing"],
        git,
      );
      const invalidAdapter = yield* runJson(
        ["--state-dir", stateDirectory, "adapter", "enable", "windsurf"],
        git,
      );

      expect(envelopeFrom(missingState)).toMatchObject({ command: "catalog" });
      expect(envelopeFrom(missingChoiceProject)).toMatchObject({
        classification: "invalid-configuration",
        command: "pick include",
        diagnostics: [
          {
            code: "project-not-found",
            details: { projectName: "missing" },
            message:
              'Project "missing" is not registered. Run `tack project` to list registered projects and roots.',
          },
        ],
      });
      expect(envelopeFrom(invalidAdapter)).toMatchObject({
        classification: "invalid-invocation",
        command: "adapter enable",
        diagnostics: [expect.objectContaining({ code: "invalid-flag" })],
      });
    }),
  );

  hostIt.effect("refuses a sync --adapter that is not enabled and names adapter enable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-host-test-" }),
      );
      const anchor = path.join(root, "anchor");
      const projectRoot = path.join(root, "project");
      yield* Effect.forEach([anchor, projectRoot], (directory) =>
        fileSystem.makeDirectory(directory, { recursive: true }),
      );
      const stateDirectory = path.join(root, "state");
      const stateOptions = {
        environment: { TACK_STATE_DIR: stateDirectory },
        homeDirectory: root,
      } satisfies StateOptions;
      const invoke = (arguments_: ReadonlyArray<string>) =>
        runJson(["--state-dir", stateDirectory, ...arguments_], testGit(anchor, projectRoot)).pipe(
          Effect.map(envelopeFrom),
        );
      for (const setup of [
        ["state", "init"],
        ["project", "add", "demo", "--repository-cwd", projectRoot],
        ["adapter", "enable", "cursor"],
      ])
        expect(yield* invoke(setup)).toMatchObject({ status: "success" });
      const before = yield* readState(stateOptions);

      const refused = yield* invoke(["sync", "--project", "demo", "--adapter", "codex", "--apply"]);
      const refusedMany = yield* invoke([
        "sync",
        "--project",
        "demo",
        ...["--adapter", "opencode", "--adapter", "cursor", "--adapter", "codex"],
      ]);
      const enabled = yield* invoke(["sync", "--project", "demo", "--adapter", "cursor"]);

      expect(refused).toMatchObject({
        classification: "invalid-configuration",
        command: "sync",
        diagnostics: [
          {
            code: "adapter-not-enabled",
            details: { adapters: ["codex"], enabledAdapters: ["cursor"] },
            message:
              "Adapter codex is not enabled, so sync does not link for it. Run `tack adapter enable codex`, then sync again.",
          },
        ],
        next: ["tack adapter enable codex"],
      });
      expect(exitCodeForEnvelope(refused)).not.toBe(0);
      expect(refusedMany).toMatchObject({
        diagnostics: [
          {
            code: "adapter-not-enabled",
            details: { adapters: ["codex", "opencode"] },
            message:
              "Adapters codex and opencode are not enabled, so sync does not link for them. Run `tack adapter enable codex opencode`, then sync again.",
          },
        ],
        next: ["tack adapter enable codex opencode"],
      });
      expect(yield* readState(stateOptions)).toEqual(before);
      expect(enabled).toMatchObject({ classification: "success", command: "sync" });
    }),
  );

  hostIt.effect("keeps each failure's specific code, message and safe fields", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-host-test-" }),
      );
      const anchor = path.join(root, "anchor");
      const projectRoot = path.join(root, "project");
      const featureRoot = path.join(root, "feature");
      const outside = path.join(root, "outside");
      yield* Effect.forEach([anchor, projectRoot, featureRoot, outside], (directory) =>
        fileSystem.makeDirectory(directory, { recursive: true }),
      );
      const invoke = (
        arguments_: ReadonlyArray<string>,
        git: GitService = testGit(anchor, projectRoot),
      ) =>
        runJson(["--state-dir", path.join(root, "state"), ...arguments_], git).pipe(
          Effect.map(envelopeFrom),
        );
      const outsideGit = {
        listWorktrees: () => Effect.die("not reached"),
        resolveCommonDirectory: (cwd: string) =>
          Effect.fail(
            new GitCommandError({
              args: ["rev-parse", "--git-common-dir"],
              code: "git-process-failed",
              command: "git",
              cwd,
              exitCode: 128,
              message: "Git exited with code 128.",
              phase: "exit",
              stderr: "fatal: not a git repository\n",
            }),
          ),
      } satisfies GitService;
      const withFeatureWorktree = {
        listWorktrees: () =>
          Effect.succeed([
            { bare: false, detached: false, path: projectRoot },
            { bare: false, detached: false, path: featureRoot },
          ]),
        resolveCommonDirectory: () => Effect.succeed(anchor),
      } satisfies GitService;
      for (const setup of [
        ["state", "init"],
        ["project", "add", "demo", "--repository-cwd", projectRoot],
        ["adapter", "enable", "claude", "cursor"],
      ])
        expect(yield* invoke(setup)).toMatchObject({ status: "success" });

      expect(yield* invoke(["status", "--project", "nope"])).toMatchObject({
        diagnostics: [
          {
            code: "project-not-found",
            details: { projectName: "nope" },
            message:
              'Project "nope" is not registered. Run `tack project` to list registered projects and roots.',
          },
        ],
      });
      expect(yield* invoke(["adapter", "enable", "codex"])).toMatchObject({
        classification: "success",
        applied: { enabledAdapters: ["claude", "codex", "cursor"] },
      });
      expect(
        yield* invoke(["project", "add", "elsewhere", "--repository-cwd", outside], outsideGit),
      ).toMatchObject({
        classification: "invalid-configuration",
        diagnostics: [
          {
            code: "repository-cwd-not-in-git",
            details: { path: outside },
            message: "This directory is not inside a Git repository.",
          },
        ],
        next: ["tack project add elsewhere --repository-cwd PATH"],
      });
      expect(
        yield* invoke(
          ["project", "add", "demo", "--repository-cwd", projectRoot],
          withFeatureWorktree,
        ),
      ).toMatchObject({
        classification: "domain",
        diagnostics: [
          {
            code: "project-registration-conflict",
            details: {
              existingRoots: [projectRoot],
              observedRoots: [featureRoot, projectRoot],
              projectName: "demo",
            },
            message: expect.stringContaining("tack project refresh --project demo --apply"),
          },
        ],
      });
      expect(yield* invoke(["status", "--cwd", outside])).toMatchObject({
        diagnostics: [
          {
            code: "bare-target-requires-registered-root",
            details: { path: outside },
            message:
              "This directory is not inside a registered project. Choose --project NAME, --user or --all.",
          },
        ],
      });
    }),
  );

  hostIt.effect("refuses the user scope to an in-process run that names no throwaway HOME", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-host-test-" });
      const state = path.join(root, "state");
      const home = process.env["HOME"];
      expect(
        envelopeFrom(yield* runJson(["--state-dir", state, "state", "init"], testGit(root, root))),
      ).toMatchObject({ status: "success" });
      for (const argv of [
        ["sync", "--user", "--apply"],
        ["status", "--user"],
      ])
        expect(
          envelopeFrom(yield* runJson(["--state-dir", state, ...argv], testGit(root, root))),
        ).toMatchObject({ diagnostics: [{ code: "home-directory-unavailable" }] });
      expect(process.env["HOME"]).toBe(home);
    }),
  );

  hostIt.effect("reports an unknown project the same way from every command (A8)", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-host-test-" }),
      );
      const projectRoot = path.join(root, "project");
      yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
      const runs = ExecutionPlatform.of({
        cancellation: () => Effect.sync(makeRunCancellation),
        input: () => Effect.succeed(null),
        createHistory: () => Effect.void,
        finishHistory: () => Effect.void,
        packageReady: () => Effect.die("not reached"),
        worker: () => Effect.die("not reached"),
        listHistory: () => Effect.die("not reached"),
        countHistory: () => Effect.die("not reached"),
        showHistory: () => Effect.die("not reached"),
        clearHistory: () => Effect.die("not reached"),
      });
      // `script run` resolves the user scope, so the home is the throwaway root.
      const invoke = (arguments_: ReadonlyArray<string>) =>
        runHost({
          args: ["--json", "--state-dir", path.join(root, "state"), ...arguments_],
          git: testGit(root, projectRoot),
          env: { HOME: root },
        }).pipe(Effect.provideService(ExecutionPlatform, runs));
      for (const setup of [
        ["state", "init"],
        ["project", "add", "workspace", "--repository-cwd", projectRoot],
      ])
        expect(envelopeFrom(yield* invoke(setup))).toMatchObject({ status: "success" });
      const nope = ["--project", "nope"];
      const sourceId = "00000000-0000-4000-8000-000000000001";

      for (const argv of [
        ["status", ...nope],
        ["sync", ...nope],
        ["sync", ...nope],
        ["state", "clean", ...nope],
        ["state", "clean", "--pending", ...nope],
        ["project", "refresh", ...nope],
        ["pick", ...nope],
        ["pick", "include", "alpha", ...nope],
        ["pick", "remove", "alpha", ...nope],
        ["docs", "list", ...nope],
        ["docs", "target", ...nope],
        ["sync", "--no-adapters", ...nope],
        ["docs", "attach", `${sourceId}:handbook`, ...nope],
        ["docs", "detach", `${sourceId}:handbook`, ...nope],
        ["docs", "search", "query", ...nope],
        ["docs", "serve", ...nope],
      ]) {
        const result = yield* invoke(argv);
        expect({ argv, envelope: envelopeFrom(result) }).toMatchObject({
          envelope: {
            classification: "invalid-configuration",
            diagnostics: [{ code: "project-not-found", details: { projectName: "nope" } }],
            status: "failure",
          },
        });
        expect(exitCodeForEnvelope(envelopeFrom(result))).toBe(2);
      }
      // A run outcome keeps its snake_case code (decision 2) and shares the classification.
      const run = envelopeFrom(yield* invoke(["script", "run", "x", ...nope]));
      expect(run).toMatchObject({
        classification: "invalid-configuration",
        diagnostics: [
          { code: "run_project_not_registered", details: { outcome: { projectName: "nope" } } },
        ],
      });
      expect(exitCodeForEnvelope(run)).toBe(2);
    }),
  );

  hostIt.effect(
    "dispatches dry-run maintenance and read-only status through public envelopes",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-host-test-" });
        const stateDirectory = path.join(root, "state");
        const anchor = path.join(root, "anchor");
        yield* fileSystem.makeDirectory(anchor, { recursive: true });
        const cwd = path.resolve(".");
        const git = testGit(yield* fileSystem.realPath(anchor), yield* fileSystem.realPath(cwd));
        const invoke = (arguments_: ReadonlyArray<string>) =>
          runJson(["--state-dir", stateDirectory, ...arguments_], git);

        yield* invoke(["state", "init"]);
        yield* invoke(["project", "add", "workspace", "--repository-cwd", cwd]);
        yield* invoke(["adapter", "enable", "cursor", "codex"]);

        const disablement = envelopeFrom(yield* invoke(["adapter", "disable", "cursor"]));
        const refresh = envelopeFrom(
          yield* invoke(["project", "refresh", "--project", "workspace"]),
        );
        const status = envelopeFrom(yield* invoke(["status", "--project", "workspace"]));
        const clean = envelopeFrom(yield* invoke(["state", "clean", "--project", "workspace"]));

        expect(disablement).toMatchObject({
          applied: null,
          classification: "success",
          command: "adapter disable",
          plan: {
            adapter: "cursor",
            enabledAdapters: ["codex"],
            kind: "adapter-disablement-plan",
          },
          result: null,
        });
        expect(refresh).toMatchObject({
          applied: null,
          classification: "success",
          command: "project refresh",
          plan: {
            kind: "project-refresh-command-plan",
            refresh: { scope: { _tag: "project", projectName: "workspace" } },
            removals: [],
          },
          result: null,
        });
        expect(status).toMatchObject({
          applied: null,
          classification: "success",
          command: "status",
          plan: null,
          result: { kind: "skill-status", scope: { _tag: "project", projectName: "workspace" } },
        });
        expect(clean).toMatchObject({
          applied: null,
          classification: "success",
          command: "state clean",
          plan: { cause: "clean", scope: { _tag: "selected-targets" } },
          result: null,
        });
      }),
  );

  hostIt.effect("disables an adapter on fresh state from an unregistered directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-host-test-" }),
      );
      const invoke = (arguments_: ReadonlyArray<string>) =>
        runJson(["--state-dir", path.join(root, "state"), ...arguments_], testGit(root, root));
      yield* invoke(["state", "init"]);
      yield* invoke(["adapter", "enable", "claude"]);

      const preview = envelopeFrom(yield* invoke(["adapter", "disable", "claude"]));
      const applied = envelopeFrom(yield* invoke(["adapter", "disable", "claude", "--apply"]));
      const listed = envelopeFrom(yield* invoke(["adapter", "list"]));

      expect(preview).toMatchObject({
        classification: "success",
        plan: { adapter: "claude", enabledAdapters: [], expectedEnabledAdapters: ["claude"] },
      });
      expect(applied).toMatchObject({
        applied: { adapter: "claude", enabledAdapters: [] },
        classification: "success",
      });
      expect(listed.result).toEqual({ kind: "adapters", enabledAdapters: [] });
    }),
  );

  hostIt.effect("reports failed and applied cleanup units as a partial public outcome", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-cli-host-test-" });
      const stateDirectory = path.join(root, "state");
      const projectRootPath = path.join(root, "project");
      const sourceAlphaPath = path.join(root, "source-alpha");
      const sourceBetaPath = path.join(root, "source-beta");
      yield* Effect.forEach([projectRootPath, sourceAlphaPath, sourceBetaPath], (directory) =>
        fileSystem.makeDirectory(directory, { recursive: true }),
      );
      const projectRoot = yield* fileSystem.realPath(projectRootPath);
      const sourceAlpha = yield* fileSystem.realPath(sourceAlphaPath);
      const sourceBeta = yield* fileSystem.realPath(sourceBetaPath);
      const destinationAlpha = path.join(projectRoot, ".agents", "skills", "alpha");
      const destinationBeta = path.join(projectRoot, ".agents", "skills", "beta");
      yield* fileSystem.makeDirectory(path.dirname(destinationAlpha), { recursive: true });
      yield* fileSystem.symlink(
        path.relative(path.dirname(destinationAlpha), sourceAlpha),
        destinationAlpha,
      );
      yield* fileSystem.symlink(
        path.relative(path.dirname(destinationBeta), sourceBeta),
        destinationBeta,
      );
      const options = {
        environment: { TACK_STATE_DIR: stateDirectory },
        homeDirectory: "",
      } satisfies StateOptions;
      yield* initializeState(options);
      const evidence = (name: string, sourceDirectoryPath: string) => ({
        adapter: "codex" as const,
        address: {
          kind: "skill" as const,
          name,
          sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
        },
        sourceDirectoryPath,
        sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
        target: {
          _tag: "project-root" as const,
          canonicalPath: projectRoot,
          projectName: "workspace",
        },
      });
      yield* mutateState(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          managedLinks: [evidence("alpha", sourceAlpha), evidence("beta", sourceBeta)],
          projects: [
            {
              gitCommonDirectory: path.join(projectRoot, ".git"),
              name: "workspace",
              roots: [projectRoot],
            },
          ],
        },
      }));
      const failingFileSystem = FileSystem.makeNoop({
        ...fileSystem,
        remove: (candidate, removeOptions) =>
          candidate === destinationAlpha
            ? Effect.fail(PlatformError.badArgument({ module: "test", method: "remove" }))
            : fileSystem.remove(candidate, removeOptions),
      });
      const git = testGit(path.join(projectRoot, ".git"), projectRoot);

      const envelope = envelopeFrom(
        yield* runJson(
          ["--state-dir", stateDirectory, "state", "clean", "--project", "workspace", "--apply"],
          git,
          failingFileSystem,
        ),
      );

      expect(envelope).toMatchObject({
        applied: {
          actions: [{ _tag: "failed", code: "filesystem-failure" }, { _tag: "applied" }],
        },
        classification: "partial",
        command: "state clean",
        diagnostics: [
          {
            code: "removal-failed",
            details: { subject: { destinationPath: destinationAlpha } },
            severity: "warning",
          },
        ],
        status: "partial",
      });
      expect(yield* fileSystem.exists(destinationAlpha)).toBe(true);
      expect(yield* fileSystem.exists(destinationBeta)).toBe(false);
    }),
  );
});

it.layer(LiveTestLayer)("CLI output format parity", (formatIt) => {
  formatIt.effect("defaults to human in pipes, agents, CI, and uncertain terminals", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-format-host-" });
      const state = path.join(root, "state");
      const git = testGit(root, root);
      yield* runHostRaw(["--json", "--state-dir", state, "state", "init"], git);
      const interactive: TerminalContextShape = {
        columns: 80,
        environment: { TERM: "xterm-256color" },
        stdinIsTerminal: true,
        stdoutIsTerminal: true,
      };
      const args = ["--state-dir", state, "catalog"];
      const explicit = yield* runHostRaw(["--json", ...args], git, undefined, interactive);
      for (const context of [
        { ...interactive, stdoutIsTerminal: false },
        { ...interactive, stdinIsTerminal: false },
        { ...interactive, environment: {} },
        { ...interactive, environment: { TERM: "dumb" } },
        { ...interactive, environment: { TERM: "xterm", TACK_FORMAT: "json" } },
        { ...interactive, environment: { TERM: "xterm", CI: "true", TACK_FORMAT: "human" } },
        ...[
          "AI_AGENT",
          "CLAUDECODE",
          "CLAUDE_CODE",
          "CODEX_CI",
          "CODEX_SANDBOX",
          "CODEX_THREAD_ID",
          "CURSOR_AGENT",
          "CURSOR_TRACE_ID",
          "GEMINI_CLI",
          "OPENCODE",
          "OPENCODE_CLIENT",
        ].map((marker) => ({
          ...interactive,
          environment: { TERM: "xterm", TACK_FORMAT: "human", [marker]: "1" },
        })),
      ]) {
        const actual = yield* runHostRaw(args, git, undefined, context);
        const flagged = yield* runHostRaw(["--json", ...args], git, undefined, context);
        expect(actual.stdout).toContain("tack catalog");
        expect(actual.stdout).not.toBe(explicit.stdout);
        expect(flagged.stdout).toBe(explicit.stdout);
        expect(actual.exit).toEqual(explicit.exit);
        expect(actual.stderr).toBe(explicit.stderr);
      }
      const absent = yield* runHostRaw(args, git);
      expect(absent.stdout).toContain("tack catalog");
      const human = yield* runHostRaw(args, git, undefined, interactive);
      expect(human.stdout).toContain("tack catalog");
      expect(human.stdout).not.toBe(explicit.stdout);
      expect(human.exit).toEqual(explicit.exit);
    }),
  );

  formatIt.effect(
    "keeps classifications, exit codes, stderr, and state effects across formats",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-format-outcomes-" });
        const state = path.join(root, "state");
        const blocked = path.join(root, "blocked");
        const git = testGit(root, root);
        const interactive: TerminalContextShape = {
          columns: 80,
          environment: { TERM: "xterm" },
          stdinIsTerminal: true,
          stdoutIsTerminal: true,
        };
        yield* fileSystem.writeFileString(blocked, "a file, not a directory");
        const compare = (args: ReadonlyArray<string>, classification: string) =>
          Effect.gen(function* () {
            const json = yield* runHostRaw(["--json", ...args], git, undefined, interactive);
            const human = yield* runHostRaw([...args], git, undefined, interactive);
            expect(envelopeFrom(json).classification).toBe(classification);
            if (classification === "success") expect(human.stdout).toMatch(/✓ (ok|success)/);
            else expect(human.stdout).toContain(classification);
            expect(human.exit).toEqual(json.exit);
            expect(human.stderr).toBe(json.stderr);
            expect(json.stderr).toBe("");
          });
        yield* compare(["--state-dir", blocked, "state", "init"], "persistence");
        yield* compare(["--state-dir", state, "catalog"], "invalid-configuration");
        yield* runHostRaw(["--state-dir", state, "state", "init"], git);
        yield* compare(["--state-dir", state, "catalog"], "success");
        const source = path.join(root, "source");
        yield* fileSystem.makeDirectory(source);
        yield* fileSystem.writeFileString(path.join(source, "tack.yaml"), "version: 1\n");
        yield* runHostRaw(["--state-dir", state, "source", "add", source], git);
        yield* fileSystem.writeFileString(path.join(source, "tack.yaml"), "version: 99\n");
        yield* compare(["--state-dir", state, "source"], "partial");
        yield* compare(["--state-dir", state, "catalog", "--bogus"], "invalid-invocation");
        yield* compare(
          ["--state-dir", state, "status", "--project", "missing"],
          "invalid-configuration",
        );
        yield* runHostRaw(["--state-dir", state, "adapter", "enable", "claude", "cursor"], git);
        yield* compare(["--state-dir", state, "adapter", "enable", "codex"], "success");

        const jsonState = path.join(root, "json-state");
        const humanState = path.join(root, "human-state");
        const jsonInit = yield* runHostRaw(
          ["--json", "--state-dir", jsonState, "state", "init"],
          git,
          undefined,
          interactive,
        );
        const humanInit = yield* runHostRaw(
          ["--state-dir", humanState, "state", "init"],
          git,
          undefined,
          interactive,
        );
        expect(humanInit.exit).toEqual(jsonInit.exit);
        expect(humanInit.stderr).toBe(jsonInit.stderr);
        expect(yield* fileSystem.readFileString(path.join(humanState, "state.json"))).toBe(
          yield* fileSystem.readFileString(path.join(jsonState, "state.json")),
        );

        const pipe = { ...interactive, stdoutIsTerminal: false };
        expect(
          (yield* runHostRaw(["--state-dir", state, "catalog"], git, undefined, pipe)).stdout,
        ).not.toContain("\u001b[");
        expect(
          (yield* runHostRaw(["--state-dir", state, "catalog"], git, undefined, {
            ...interactive,
            environment: { TERM: "xterm", NO_COLOR: "1", FORCE_COLOR: "1" },
          })).stdout,
        ).not.toContain("\u001b[");
        expect(
          (yield* runHostRaw(["--state-dir", state, "catalog"], git, undefined, {
            ...pipe,
            environment: { FORCE_COLOR: "1" },
          })).stdout,
        ).toContain("\u001b[");
        expect(
          (yield* runHostRaw(
            ["--state-dir", state, "catalog", "--format", "yaml"],
            git,
            undefined,
            interactive,
          )).stdout,
        ).toContain("invalid-invocation");
        const invalidWithEnvironment = yield* runHostRaw(
          ["--json", "--state-dir", state, "catalog", "--format", "yaml"],
          git,
          undefined,
          { ...pipe, environment: { TERM: "xterm", TACK_FORMAT: "human" } },
        );
        expect(envelopeFrom(invalidWithEnvironment).classification).toBe("invalid-invocation");
        expect(envelopeFrom(invalidWithEnvironment).diagnostics[0]?.message).toContain("--json");
      }),
  );
});
