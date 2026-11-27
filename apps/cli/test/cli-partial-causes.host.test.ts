import { fakeGit } from "./support/fake-git.ts";
import { skillText } from "./support/source-tree.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { SyncPlanSchema } from "../src/domain/reconciliation/sync-schema.ts";
import { partialCauseRegistry } from "../src/cli/envelope/partial-causes.ts";
import { type PublicEnvelope } from "../src/cli/envelope/public-outcome.ts";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

/** A registered source and one registered project whose root is `projectRoot`. */
const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-partial-causes-test-" }),
  );
  const stateDirectory = path.join(root, "state");
  const anchor = path.join(root, "anchor");
  const projectRoot = path.join(root, "project");
  const source = path.join(root, "source");
  yield* Effect.forEach([anchor, projectRoot, path.join(source, "skills", "valid")], (directory) =>
    fileSystem.makeDirectory(directory, { recursive: true }),
  );
  yield* fileSystem.writeFileString(
    path.join(source, "tack.yaml"),
    "version: 1\nname: source\nskills:\n  - path: skills\n",
  );
  yield* fileSystem.writeFileString(
    path.join(source, "skills", "valid", "SKILL.md"),
    skillText("valid", { tack: ["activation: default"], body: "" }),
  );
  const git = fakeGit(anchor, [{ path: projectRoot }]);
  const run = (flags: ReadonlyArray<string>, arguments_: ReadonlyArray<string>) =>
    runHost({ args: [...flags, "--state-dir", stateDirectory, ...arguments_], git }).pipe(
      Effect.map(({ stdout }) => stdout),
    );
  const tack = (arguments_: ReadonlyArray<string>) =>
    run(["--json"], arguments_).pipe(Effect.map(decodeEnvelope));
  /** The human view of a command, as an operator reads it. */
  const human = (arguments_: ReadonlyArray<string>) => run([], arguments_);
  yield* tack(["state", "init"]);
  yield* tack(["source", "add", source, "--apply"]);
  yield* tack(["project", "add", "workspace", "--repository-cwd", projectRoot]);
  return { fileSystem, human, path, projectRoot, root, source, tack };
});

const codes = (envelope: PublicEnvelope) => envelope.diagnostics.map(({ code }) => code);

it("registers every partial-cause code as a kebab-case diagnostic code with a message", () => {
  for (const [code, message] of Object.entries(partialCauseRegistry)) {
    expect(code).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    expect(message.length).toBeGreaterThan(0);
  }
});

it.layer(LiveTestLayer)("structured partial causes", (causesIt) => {
  causesIt.effect("echoes the narrowing flags of a sync request, and only those", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;
      yield* tack(["adapter", "enable", "claude", "codex"]);
      const planOf = (flags: ReadonlyArray<string>) =>
        tack(["sync", "--project", "workspace", ...flags]).pipe(
          Effect.map(({ plan }) => Schema.decodeUnknownSync(SyncPlanSchema)(plan)),
        );

      expect((yield* planOf([])).options).toBeUndefined();
      expect(
        (yield* planOf([
          "--adapter",
          "claude",
          "--include-optional",
          "--no-docs",
          "--require-capability",
          "skill-links",
        ])).options,
      ).toEqual({
        adapters: ["claude"],
        includeOptional: true,
        noDocs: true,
        requiredCapability: "skill-links",
      });
      // `--no-adapters` is the absence of resources, not a second copy of the fact.
      const docsOnly = yield* planOf(["--no-adapters"]);
      expect(docsOnly.resources).toBeNull();
      expect(docsOnly.options).toBeUndefined();
    }),
  );
  causesIt.effect("names a status collision and its exclude commands like the sync preview", () =>
    Effect.gen(function* () {
      const { fileSystem, human, path, root, tack } = yield* fixture;
      const twin = path.join(root, "twin");
      yield* fileSystem.makeDirectory(path.join(twin, "skills", "valid"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(twin, "tack.yaml"),
        "version: 1\nname: twin\nskills:\n  - path: skills\n",
      );
      yield* fileSystem.writeFileString(
        path.join(twin, "skills", "valid", "SKILL.md"),
        skillText("valid", { tack: ["activation: default"], body: "" }),
      );
      yield* tack(["source", "add", twin, "--apply"]);
      yield* tack(["adapter", "enable", "claude"]);

      const status = yield* tack(["status", "--project", "workspace"]);
      const sync = yield* tack(["sync", "--project", "workspace"]);

      expect(codes(status)).not.toContain("destination-selection-conflict");
      const collision = status.diagnostics.find(({ code }) => code === "selection-collision");
      expect(collision?.message).toMatch(
        /^Two or more selected resources need the same destination name\. Exclude all but one: tack pick exclude \S+:valid --kind skill --project workspace or tack pick exclude \S+:valid --kind skill --project workspace\.$/,
      );
      // Status and sync tell the same story about the same fact.
      expect(sync.diagnostics.find(({ code }) => code === "selection-collision")).toEqual(
        collision,
      );

      const text = yield* human(["status", "--project", "workspace"]);
      expect(text).toContain("conflict");
      expect(text).toMatch(/needed by \S*valid,\s+\S*valid/);
      expect(text).toContain("tack pick exclude source:valid --kind skill --project workspace");
      expect(text).toContain("tack pick exclude twin:valid --kind skill --project workspace");
    }),
  );
  causesIt.effect("classifies a missing project root as partial in inspection and status", () =>
    Effect.gen(function* () {
      const { fileSystem, projectRoot, tack } = yield* fixture;

      const healthy = yield* tack(["project"]);
      yield* fileSystem.remove(projectRoot, { recursive: true });
      const inspected = yield* tack(["project"]);
      const status = yield* tack(["status", "--project", "workspace"]);

      expect(healthy).toMatchObject({
        classification: "success",
        result: { kind: "project-inspections", projects: [{ project: { name: "workspace" } }] },
      });
      const missingRoot = {
        code: "root-missing",
        details: { subject: { projectName: "workspace", root: projectRoot } },
        severity: "warning",
      };
      expect(inspected).toMatchObject({ classification: "partial", diagnostics: [missingRoot] });
      expect(status.diagnostics).toContainEqual({ ...missingRoot, message: expect.any(String) });
    }),
  );
  causesIt.effect("warns instead of reporting success when no adapter is enabled", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;

      const reconciled = yield* tack(["sync", "--project", "workspace", "--apply"]);
      const status = yield* tack(["status", "--project", "workspace"]);
      const explicit = yield* tack(["sync", "--project", "workspace", "--no-adapters"]);

      for (const envelope of [reconciled, status]) {
        expect(envelope).toMatchObject({
          classification: "partial",
          diagnostics: [
            {
              code: "no-adapters-enabled",
              details: { subject: { enabledAdapters: [] } },
              message:
                "No agent adapter is enabled, so nothing is delivered. Run `tack init` to enable the agents found in this home, or `tack adapter enable <adapter>` to enable one.",
              severity: "warning",
            },
          ],
        });
      }
      expect(status.result).toMatchObject({
        namespaces: [
          {
            undelivered: [{ address: { name: "valid" }, reason: "no-enabled-adapter" }],
          },
        ],
      });
      // An explicit `--no-adapters` asks for no delivery, so it is not a partial cause.
      expect(explicit).toMatchObject({ classification: "success", diagnostics: [] });
    }),
  );

  causesIt.effect("names the source behind a source-only partial reconciliation", () =>
    Effect.gen(function* () {
      const { fileSystem, path, source, tack } = yield* fixture;
      yield* tack(["adapter", "enable", "cursor"]);
      yield* fileSystem.writeFileString(path.join(source, "tack.yaml"), "version: 99\n");

      const reconciled = yield* tack(["sync", "--project", "workspace", "--adapter", "cursor"]);

      expect(reconciled).toMatchObject({
        classification: "partial",
        diagnostics: [
          {
            code: "source-unhealthy",
            details: {
              subject: {
                issue: { code: "declaration-version-unsupported" },
                registration: { canonicalPath: source },
              },
            },
            severity: "warning",
          },
        ],
      });
    }),
  );

  causesIt.effect.each([
    ["source-unhealthy", "tack.yaml", "version: 1\nname: source\nskillz: []\n"],
    ["catalog-quarantined", "skills/valid/SKILL.md", "---\nname: valid\n---\n"],
  ] as const)(
    "names the %s cause beside the removal of a link the operator did not deselect",
    ([code, file, text]) =>
      Effect.gen(function* () {
        const { fileSystem, human, path, source, tack } = yield* fixture;
        yield* tack(["adapter", "enable", "cursor"]);
        const sync = ["sync", "--project", "workspace", "--adapter", "cursor"];
        const reason = code === "catalog-quarantined" ? "quarantined" : code;
        yield* tack([...sync, "--apply"]);
        yield* fileSystem.writeFileString(path.join(source, file), text);

        const preview = yield* tack(sync);

        expect(codes(preview)).toContain(code);
        expect(preview.plan).toMatchObject({
          resources: {
            units: [
              {
                actions: [
                  { _tag: "link-remove", evidence: { address: { name: "valid" } }, reason },
                ],
              },
            ],
          },
        });
        expect(yield* human(sync)).toContain(`skill source:valid · ${reason}`);
      }),
  );

  causesIt.effect("names the root behind a root-only partial reconciliation", () =>
    Effect.gen(function* () {
      const { fileSystem, projectRoot, tack } = yield* fixture;
      yield* tack(["adapter", "enable", "cursor"]);
      yield* fileSystem.remove(projectRoot, { recursive: true });

      const reconciled = yield* tack(["sync", "--project", "workspace", "--adapter", "cursor"]);

      expect(reconciled).toMatchObject({
        classification: "partial",
        diagnostics: [
          {
            code: "root-missing",
            details: { subject: { projectName: "workspace", root: projectRoot } },
          },
        ],
        plan: { resources: { units: [] } },
      });
    }),
  );

  causesIt.effect("names quarantined entries in reconciliation and status", () =>
    Effect.gen(function* () {
      const { fileSystem, path, source, tack } = yield* fixture;
      yield* tack(["adapter", "enable", "cursor"]);
      const brokenDirectory = path.join(source, "skills", "broken");
      yield* fileSystem.makeDirectory(brokenDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(brokenDirectory, "SKILL.md"),
        "---\nname: x\n---\n",
      );

      const reconciled = yield* tack(["sync", "--project", "workspace", "--adapter", "cursor"]);
      const status = yield* tack(["status", "--project", "workspace"]);

      for (const envelope of [reconciled, status]) {
        expect(envelope.classification).toBe("partial");
        expect(envelope.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "catalog-quarantined",
              details: {
                subject: expect.objectContaining({
                  candidateKind: "skill",
                  candidatePath: expect.stringContaining(brokenDirectory),
                }),
              },
            }),
          ]),
        );
      }
      expect(codes(reconciled)).not.toContain("reconciliation-partial");
      expect(codes(status)).not.toContain("status-partial");
    }),
  );
  causesIt.effect("names the blocked group and the blocker of a link it removes", () =>
    Effect.gen(function* () {
      const { fileSystem, path, source, tack } = yield* fixture;
      yield* tack(["adapter", "enable", "cursor"]);
      const requester = path.join(source, "skills", "requester");
      const helper = path.join(source, "skills", "helper");
      yield* fileSystem.makeDirectory(requester, { recursive: true });
      yield* fileSystem.makeDirectory(helper, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(helper, "SKILL.md"),
        skillText("helper", { tack: ["activation: default"], body: "" }),
      );
      yield* fileSystem.writeFileString(
        path.join(requester, "SKILL.md"),
        skillText("requester", {
          tack: ["activation: default", "dependencies:", "  - kind: skill", "    name: helper"],
          body: "",
        }),
      );
      const planning = ["sync", "--project", "workspace", "--adapter", "cursor"];
      expect((yield* tack([...planning, "--apply"])).classification).toBe("success");
      yield* fileSystem.remove(helper, { recursive: true });

      const blocked = yield* tack(planning);

      const helperAddress = { kind: "skill", name: "helper" };
      const requesterAddress = { kind: "skill", name: "requester" };
      const blocker = {
        _tag: "required-missing",
        dependency: helperAddress,
        requester: expect.objectContaining(requesterAddress),
      };
      expect(blocked).toMatchObject({
        classification: "partial",
        diagnostics: [
          {
            code: "dependency-blocked",
            details: {
              subject: {
                blockers: [blocker],
                members: [expect.objectContaining(requesterAddress)],
                namespace: { _tag: "project", projectName: "workspace" },
              },
            },
          },
        ],
        plan: {
          resources: {
            units: [
              {
                actions: expect.arrayContaining([
                  expect.objectContaining({
                    _tag: "link-remove",
                    blockers: [blocker],
                    evidence: expect.objectContaining({
                      address: expect.objectContaining(requesterAddress),
                    }),
                    reason: "blocked",
                  }),
                ]),
                summary: { blocked: 1, create: 0, remove: 2 },
              },
            ],
          },
        },
      });
    }),
  );
  causesIt.effect("refuses a pick that does not name a healthy catalog resource", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;
      const choose = (name: string) => tack(["pick", "include", name, "--project", "workspace"]);

      const mistyped = yield* choose("vaild");
      const exact = yield* choose("valid");

      expect(mistyped).toMatchObject({
        applied: null,
        classification: "invalid-configuration",
        diagnostics: [
          {
            code: "resource-not-found",
            severity: "error",
          },
        ],
      });
      expect(exact).toMatchObject({ classification: "success", diagnostics: [] });
    }),
  );
  causesIt.effect(
    "echoes the requested selector and resolved targets in clean and retry plans",
    () =>
      Effect.gen(function* () {
        const { projectRoot, tack } = yield* fixture;
        const selection = {
          selector: { _tag: "project", projectName: "workspace" },
          targets: [{ _tag: "project-root", canonicalPath: projectRoot, projectName: "workspace" }],
        };

        for (const command of [
          ["state", "clean"],
          ["state", "clean", "--pending"],
        ]) {
          expect(yield* tack([...command, "--project", "workspace"])).toMatchObject({
            classification: "success",
            plan: { selection },
          });
        }
      }),
  );
});
