import { skillText } from "./support/source-tree.ts";
import { fakeGit } from "./support/fake-git.ts";
import { stageChange } from "../src/cli/host/human/explorer/edit.ts";
import { checkPaths } from "../src/features/check/check-paths.ts";
import { Git } from "../src/services/git.ts";
import { registerSource } from "../src/features/sources/source.ts";
import { makeExplorerDestinations } from "../src/cli/host/human/explorer/profile-editor.ts";
import { initialExplorerState, stepExplorer } from "../src/cli/host/human/explorer/model.ts";
import { makeStyle } from "../src/cli/host/human/style.ts";
import type { RouteServices } from "../src/cli/host/routes/route.ts";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { profileFixture } from "./support/profile-fixture.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { mutateStateFixture } from "./support/state-fixture.ts";
import { readState } from "../src/services/state-store.ts";
import {
  collectProfileInput,
  runProfileSaveSelection,
  runProfileAdopt,
} from "../src/features/profiles/profile-copy.ts";
import { runProfileApply } from "../src/features/profiles/profile-apply.ts";
import { readInvocationSnapshot } from "../src/features/snapshot/command-snapshot.ts";

it.layer(LiveTestLayer)("independent profile copies", (test) => {
  test.effect(
    "keeps portable external ownership even when unique and refuses unnamed sources",
    () =>
      Effect.gen(function* () {
        const {
          options,
          root,
          source,
          write,
          fs,
          path,
          run,
          request: applyRequest,
        } = yield* profileFixture;
        yield* write("team/tack.yaml", "version: 2\nname: team\ncommands: [{path: audit.md}]\n");
        yield* write("team/audit.md", "Audit");
        const external = yield* registerSource(options, {
          sourcePath: path.join(root, "team"),
        });
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            userChoices: [
              {
                address: {
                  kind: "command",
                  name: "audit",
                  sourceRegistrationId: external.registration.id,
                },
                decision: "include",
              },
            ],
          },
        }));
        const request = {
          input: { user: true },
          sourcePath: source,
          name: "portable",
          edit: false,
          apply: true,
        };
        expect((yield* runProfileSaveSelection(options, request)).saved).toBe(true);
        const profile = Bun.YAML.parse(
          yield* fs.readFileString(path.join(source, "profiles/portable.yaml")),
        );
        expect(profile).toMatchObject({
          "depends-on": ["team"],
          members: [{ name: "audit", kind: "command", source: "team" }],
        });
        expect((yield* checkPaths([source, path.join(root, "team")])).summary.errors).toBe(0);
        expect(
          (yield* run(
            runProfileApply(options, {
              ...applyRequest,
              reference: "tools:portable",
              apply: false,
            }),
          )).plan.refused,
        ).toBe(false);
        yield* write("team/tack.yaml", "version: 2\ncommands: [{path: audit.md}]\n");
        expect(
          (yield* runProfileSaveSelection(options, { ...request, name: "unnamed" })).plan.findings,
        ).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "profile-copy-source-name" })]),
        );
        const unnamedCheck = yield* checkPaths([
          path.join(source, "profiles/portable.yaml"),
          path.join(root, "team"),
        ]);
        expect(unnamedCheck.findings).toContainEqual(
          expect.objectContaining({
            code: "profile-source-name",
            remedy: expect.stringContaining("name"),
          }),
        );
        expect(
          (yield* run(
            runProfileApply(options, {
              ...applyRequest,
              reference: "tools:portable",
              apply: false,
            }),
          )).plan.refused,
        ).toBe(true);
        yield* write("team/tack.yaml", "version: 2\nname: team\ncommands: [{path: audit.md}]\n");
        yield* fs.rename(path.join(root, "team"), path.join(root, "different-checkout"));
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            sources: state.data.sources.map((entry) =>
              entry.id === external.registration.id
                ? { ...entry, canonicalPath: path.join(root, "different-checkout") }
                : entry,
            ),
          },
        }));
        expect(
          (yield* checkPaths([source, path.join(root, "different-checkout")])).summary.errors,
        ).toBe(0);
        expect(
          (yield* runProfileSaveSelection(options, { ...request, name: "relocated" })).saved,
        ).toBe(true);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            sources: state.data.sources.filter(
              (registration) => registration.id !== external.registration.id,
            ),
          },
        }));
        yield* write("source/audit.md", "A different audit");
        yield* write(
          "source/tack.yaml",
          "version: 2\nname: tools\ncommands: [{path: audit.md}]\nprofiles: [{name: portable, path: profiles/portable.yaml}]\n",
        );
        const checked = yield* checkPaths([path.join(source, "profiles/portable.yaml")]);
        expect(checked.checks.flatMap((item) => item.details)).toContain("Direct members (0)");
        expect(checked.findings[0]?.code).toBe("profile-source-unregistered");
      }),
  );
  test.effect("explains mixed-kind adoption, refuses user docs and keeps scripts inert", () =>
    Effect.gen(function* () {
      const { options, request, run, write, sourceId, project } = yield* profileFixture;
      yield* write(
        "source/tack.yaml",
        "version: 2\nname: tools\ncontext: [{path: context.md}]\ndocs: [{name: handbook, path: docs}]\nscripts: [{name: deploy, path: deploy.ts, description: Deploy}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
      );
      yield* write("source/context.md", "Context");
      yield* write("source/docs/intro.md", "# Intro");
      yield* write("source/deploy.ts", "throw new Error('never execute');");
      yield* write(
        "source/ci.yaml",
        "version: 1\nname: ci\nmembers: [{kind: context, name: context.md}, {kind: docs, name: handbook}, {kind: script, name: deploy}]\n",
      );
      const user = yield* run(
        runProfileAdopt(options, {
          reference: "tools:ci",
          namespace: { _tag: "user" },
          apply: true,
          cwd: project,
        }),
      );
      expect(user.adopted).toBe(false);
      expect(user.plan.findings[0]?.code).toBe("profile-docs-require-project");
      const adopted = yield* run(
        runProfileAdopt(options, {
          reference: "tools:ci",
          namespace: request.namespace,
          apply: true,
          cwd: project,
        }),
      );
      expect(adopted.adopted).toBe(true);
      expect(adopted.plan.notes.join(" ")).toContain("explicit run only");
      expect(adopted.plan.notes.join(" ")).toContain("ordinary selection role");
      const state = yield* readState(options);
      expect(state.data.projects[0]?.docs?.attachments).toEqual([
        { name: "handbook", sourceRegistrationId: sourceId },
      ]);
      expect(state.data.projects[0]?.choices?.map((choice) => choice.address.kind)).toEqual([
        "context",
      ]);
    }),
  );
  test.effect("keeps the full browse save flow in-window and cancellation writes nothing", () =>
    Effect.gen(function* () {
      const { options, project, fs, path, source } = yield* profileFixture;
      const before = yield* readState(options);
      const destinations = yield* makeExplorerDestinations({
        stateOptions: options,
        cwd: project,
        style: makeStyle({ color: false, width: 120, homeDirectory: options.homeDirectory }),
        context: yield* Effect.context<RouteServices>().pipe(
          Effect.provideService(Git, fakeGit("/unused", [])),
        ),
      });
      const copyOptions = destinations.options.filter(
        (option) => option.destination["_tag"] === "copy",
      );
      expect(copyOptions.map((option) => option.label)).toEqual([
        "User + project ci (default)",
        "Project ci only",
        "User only",
      ]);
      const opened = yield* destinations.open(
        { ...initialExplorerState("Tack", []), destinations: destinations.options },
        { _tag: "copy", input: { user: true, projectName: "ci" } },
      );
      if (opened.editor === undefined) throw new Error("Missing copy editor");
      expect(stepExplorer(opened.state, { name: "c", input: "c", ctrl: false })).toMatchObject({
        _tag: "review",
      });
      expect((yield* opened.editor.preview([])).join("\n")).toContain("project ci");
      const choose = yield* opened.editor.apply([]);
      expect(choose.nextState?.destinationMenu).toMatchObject({ phase: "choose" });
      expect(
        choose.nextState?.destinationMenu?.phase === "choose"
          ? choose.nextState.destinationMenu.options?.[0]?.destination
          : undefined,
      ).toMatchObject({ seed: expect.any(Array) });
      expect(yield* fs.exists(path.join(source, "profiles/copied.yaml"))).toBe(false);
      const target = yield* destinations.open(opened.state, {
        _tag: "profile",
        sourcePath: source,
        profileName: "copied",
        create: true,
        seed: [
          {
            address: {
              kind: "skill",
              name: "notes",
              sourceRegistrationId: before.data.sources[0]?.id ?? "",
            },
            origins: ["project ci"],
          },
        ],
      });
      if (target.editor === undefined) throw new Error("Missing target editor");
      const preview = yield* target.editor.preview([]);
      for (const line of preview) expect(line).not.toMatch(/[\r\n]/);
      const diff = preview.join("\n");
      expect(diff).toContain("--- before");
      expect(diff).toContain("+++ after");
      expect(diff).toContain("Publication: add copied");
      expect(yield* readState(options)).toEqual(before);
      expect((yield* target.editor.apply([])).lines.join("\n")).toContain("Saved profile copied");
      expect(yield* readState(options)).toEqual(before);
      const existingBytes = yield* fs.readFileString(path.join(source, "ci.yaml"));
      const existing = yield* destinations.open(opened.state, {
        _tag: "profile",
        sourcePath: source,
        profileName: "ci",
        create: false,
        seed: [
          {
            address: {
              kind: "skill",
              name: "notes",
              sourceRegistrationId: before.data.sources[0]?.id ?? "",
            },
            origins: ["project ci"],
          },
        ],
      });
      expect(stepExplorer(existing.state, { name: "c", input: "c", ctrl: false })).toMatchObject({
        _tag: "review",
      });
      expect(yield* fs.readFileString(path.join(source, "ci.yaml"))).toBe(existingBytes);
    }),
  );
  test.effect(
    "refuses incomplete inputs and collisions without hidden winners, and reports remaining ordinary blockers",
    () =>
      Effect.gen(function* () {
        const { options, request, run, sourceId, project, root, write, path } =
          yield* profileFixture;
        const empty = yield* collectProfileInput(yield* readInvocationSnapshot(options), {
          user: false,
        });
        expect(empty.findings[0]?.code).toBe("profile-copy-input");
        expect(
          (yield* collectProfileInput(yield* readInvocationSnapshot(options), {
            user: false,
            projectName: "missing",
          })).findings[0]?.code,
        ).toBe("profile-copy-input");
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            userChoices: [
              {
                address: { kind: "command", name: "ghost", sourceRegistrationId: sourceId },
                decision: "include",
              },
              {
                address: { kind: "skill", name: "review", sourceRegistrationId: sourceId },
                decision: "include",
              },
              {
                address: { kind: "skill", name: "style", sourceRegistrationId: sourceId },
                decision: "exclude",
              },
              {
                address: { kind: "skill", name: "phantom", sourceRegistrationId: sourceId },
                decision: "exclude",
              },
            ],
          },
        }));
        const unresolved = (yield* collectProfileInput(yield* readInvocationSnapshot(options), {
          user: true,
        })).findings[0];
        expect(unresolved?.code).toBe("profile-copy-input-unresolved");
        // The refusal names what it would otherwise omit.
        expect(unresolved?.message).toContain(
          "user has missing or blocked identities: command ghost (missing), skill phantom (excluded but missing), skill review needs skill style (excluded).",
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, userChoices: state.data.userChoices.slice(0, 1) },
        }));
        const adopted = yield* run(
          runProfileAdopt(options, {
            reference: "tools:ci",
            namespace: { _tag: "user" },
            apply: true,
            cwd: project,
          }),
        );
        expect(adopted.adopted).toBe(true);
        expect(adopted.plan.blockers.length).toBeGreaterThan(0);
        yield* write("other/tack.yaml", "version: 2\nname: other\nskills: [{path: skills}]\n");
        yield* write(
          "other/skills/notes/SKILL.md",
          skillText("notes", { description: "Other", body: "" }),
        );
        yield* registerSource(options, { sourcePath: path.join(root, "other") });
        const collision = yield* collectProfileInput(yield* readInvocationSnapshot(options), {
          user: false,
          projectName: "ci",
        });
        expect(collision.members.filter((member) => member.address.name === "notes")).toHaveLength(
          2,
        );
        expect(collision.findings[0]?.code).toBe("profile-copy-collision");
        expect(
          (yield* run(
            runProfileAdopt(options, {
              reference: "missing:ci",
              namespace: request.namespace,
              apply: true,
              cwd: project,
            }),
          )).adopted,
        ).toBe(false);
      }),
  );
  test.effect(
    "refuses saving fixed intent or missing docs as an apparently complete daily snapshot",
    () =>
      Effect.gen(function* () {
        const fixed = yield* profileFixture;
        yield* fixed.run(runProfileApply(fixed.options, fixed.request));
        expect(
          (yield* collectProfileInput(yield* readInvocationSnapshot(fixed.options), {
            user: false,
            projectName: "ci",
          })).findings[0]?.code,
        ).toBe("profile-copy-input-fixed");
        const ordinary = yield* profileFixture;
        yield* mutateStateFixture(ordinary.options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: state.data.projects.map((project) => ({
              ...project,
              docs: { attachments: [{ name: "missing", sourceRegistrationId: ordinary.sourceId }] },
            })),
          },
        }));
        const input = yield* collectProfileInput(yield* readInvocationSnapshot(ordinary.options), {
          user: false,
          projectName: "ci",
        });
        expect(input.members.map((member) => member.address.name)).toContain("missing");
        expect(input.findings[0]?.code).toBe("profile-copy-input-unresolved");
      }),
  );
  test.effect(
    "composes user and one named project, folds identities with origins and never copies another project",
    () =>
      Effect.gen(function* () {
        const { options, sourceId, project, root } = yield* profileFixture;
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            userChoices: [
              {
                address: { kind: "skill", name: "review", sourceRegistrationId: sourceId },
                decision: "include",
              },
            ],
            projects: [
              ...state.data.projects,
              {
                name: "other",
                gitCommonDirectory: root + "/other-git",
                roots: [root + "/other"],
                choices: [
                  {
                    address: { kind: "skill", name: "private", sourceRegistrationId: sourceId },
                    decision: "include",
                  },
                ],
              },
            ],
          },
        }));
        const snapshot = yield* readInvocationSnapshot(options);
        const combined = yield* collectProfileInput(snapshot, { user: true, projectName: "ci" });
        expect(combined.findings).toEqual([]);
        expect(combined.members.map((member) => member.address.name).sort()).toEqual([
          "notes",
          "review",
          "style",
        ]);
        expect(combined.members.find((member) => member.address.name === "style")?.origins).toEqual(
          ["user", "project ci"],
        );
        const user = yield* collectProfileInput(snapshot, { user: true });
        expect(user.members.map((member) => member.address.name).sort()).toEqual([
          "review",
          "style",
        ]);
        const onlyProject = yield* collectProfileInput(snapshot, {
          user: false,
          projectName: "ci",
        });
        expect(onlyProject.members.map((member) => member.address.name).sort()).toEqual([
          "notes",
          "style",
        ]);
        const savedState = yield* readState(options);
        const saved = yield* runProfileSaveSelection(options, {
          input: { user: true, projectName: "ci" },
          sourcePath: project + "/../source",
          name: "copied",
          edit: false,
          apply: true,
        });
        expect(saved.saved).toBe(true);
        expect(yield* readState(options)).toEqual(savedState);
      }),
  );
  test.effect(
    "previews file/publication changes, requires explicit edits and leaves copies independent",
    () =>
      Effect.gen(function* () {
        const { options, source, write, fs, path } = yield* profileFixture;
        const request = {
          input: { user: false, projectName: "ci" },
          sourcePath: source,
          name: "copied",
          edit: false,
          apply: false,
        };
        const preview = yield* runProfileSaveSelection(options, request);
        expect(preview.plan.profileAfter).toContain("notes");
        expect(preview.plan.publicationAfter).toContain("copied");
        expect(yield* fs.exists(path.join(source, "profiles/copied.yaml"))).toBe(false);
        expect((yield* runProfileSaveSelection(options, { ...request, apply: true })).saved).toBe(
          true,
        );
        const bytes = yield* fs.readFileString(path.join(source, "profiles/copied.yaml"));
        yield* write(
          "source/skills/later/SKILL.md",
          skillText("later", { description: "Later", body: "" }),
        );
        expect(yield* fs.readFileString(path.join(source, "profiles/copied.yaml"))).toBe(bytes);
        expect(
          (yield* runProfileSaveSelection(options, { ...request, apply: true })).plan.findings[0]
            ?.code,
        ).toBe("profile-copy-edit-required");
        const edited = yield* runProfileSaveSelection(options, { ...request, edit: true });
        expect(edited.plan.added.map((address) => address.name)).toContain("later");
        expect(edited.saved).toBe(false);
      }),
  );
  test.effect(
    "adopts positive daily picks, preserves unrelated intent and never subscribes or delivers",
    () =>
      Effect.gen(function* () {
        const { options, request, run, sourceId, source, fs, path, project, write } =
          yield* profileFixture;
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: state.data.projects.map((p) => ({
              ...p,
              choices: [
                {
                  address: { kind: "skill", name: "review", sourceRegistrationId: sourceId },
                  decision: "exclude",
                },
                {
                  address: { kind: "skill", name: "notes", sourceRegistrationId: sourceId },
                  decision: "include",
                },
              ],
            })),
          },
        }));
        const before = yield* readState(options);
        const preview = yield* run(
          runProfileAdopt(options, {
            reference: "tools:ci",
            namespace: request.namespace,
            apply: false,
            cwd: project,
          }),
        );
        expect(preview.plan.includes.map((address) => address.name).sort()).toEqual([
          "review",
          "style",
        ]);
        expect(yield* readState(options)).toEqual(before);
        expect(
          (yield* run(
            runProfileAdopt(options, {
              reference: "tools:ci",
              namespace: request.namespace,
              apply: true,
              cwd: project,
            }),
          )).adopted,
        ).toBe(true);
        const choices = (yield* readState(options)).data.projects[0]?.choices;
        expect(choices).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              decision: "include",
              address: expect.objectContaining({ name: "review" }),
            }),
            expect.objectContaining({ address: expect.objectContaining({ name: "notes" }) }),
          ]),
        );
        expect(yield* fs.exists(path.join(project, ".agents"))).toBe(false);
        const profile = yield* fs.readFileString(path.join(source, "ci.yaml"));
        yield* write("source/ci.yaml", "version: 1\nname: ci\nmembers: []\n");
        expect((yield* readState(options)).data.projects[0]?.choices).toEqual(choices);
        expect(profile).toContain("review");
      }),
  );
  test.effect("refuses adoption into a fixed context before writing ignored picks", () =>
    Effect.gen(function* () {
      const { options, request, run, project } = yield* profileFixture;
      yield* run(runProfileApply(options, request));
      const before = yield* readState(options);
      const result = yield* run(
        runProfileAdopt(options, {
          reference: "tools:ci",
          namespace: request.namespace,
          apply: true,
          cwd: project,
        }),
      );
      expect(result.plan.findings[0]?.code).toBe("profile-fixed-context");
      expect(yield* readState(options)).toEqual(before);
    }),
  );
  test.effect(
    "adjusts an actual copy: adds and removes members, reintroduces required dependencies and narrows cross-level collisions",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        yield* f.write("team/tack.yaml", "version: 1\nname: team\nskills: [{path: skills}]\n");
        yield* f.write(
          "team/skills/review/SKILL.md",
          skillText("review", {
            description: "External review",
            tack: ["activation: opt-in"],
            body: "",
          }),
        );
        yield* f.write(
          "source/skills/extra/SKILL.md",
          skillText("extra", { description: "Extra", tack: ["activation: opt-in"], body: "" }),
        );
        const team = yield* registerSource(f.options, { sourcePath: f.path.join(f.root, "team") });
        yield* mutateStateFixture(f.options, (state) => ({
          ...state,
          data: {
            ...state.data,
            userChoices: [
              {
                address: { kind: "skill", name: "review", sourceRegistrationId: f.sourceId },
                decision: "include",
              },
            ],
            projects: state.data.projects.map((project) => ({
              ...project,
              choices: [
                {
                  address: {
                    kind: "skill",
                    name: "review",
                    sourceRegistrationId: team.registration.id,
                  },
                  decision: "include",
                },
              ],
            })),
          },
        }));
        const before = yield* readState(f.options);
        yield* f.run(
          Effect.gen(function* () {
            const destinations = yield* makeExplorerDestinations({
              stateOptions: f.options,
              cwd: f.project,
              style: makeStyle({ color: false, width: 120, homeDirectory: f.home }),
              context: yield* Effect.context<RouteServices>(),
            });
            const opened = yield* destinations.open(initialExplorerState("Tack", []), {
              _tag: "copy",
              input: { user: true, projectName: "ci" },
            });
            if (opened.editor === undefined || opened.state.edit === undefined)
              throw new Error("Missing copy editor");
            expect((yield* opened.editor.preview([])).join("\n")).toContain(
              "profile-copy-collision",
            );
            expect((yield* opened.editor.apply([])).nextState).toBeUndefined();
            let edit = opened.state.edit;
            for (const [sourceId, name, action] of [
              [team.registration.id, "review", "exclude"],
              [f.sourceId, "style", "exclude"],
              [f.sourceId, "notes", "exclude"],
              [f.sourceId, "extra", "include"],
            ] as const) {
              const entry = opened.state.entries.find(
                (candidate) =>
                  candidate.address?.sourceRegistrationId === sourceId &&
                  candidate.address.name === name,
              );
              if (entry === undefined) throw new Error(`Missing ${name}`);
              edit = stageChange(edit, entry.id, entry.editable, action);
            }
            const pending = [...edit.pending.values()];
            const review = (yield* opened.editor.preview(pending)).join("\n");
            expect(review).not.toContain("profile-copy-collision");
            expect(review).not.toContain(`${team.registration.id}:review`);
            expect(review).toContain(`${f.sourceId}:style · required dependency`);
            expect(review).toContain(`${f.sourceId}:extra · explicit adjustment`);
            const choose = yield* opened.editor.apply(pending);
            const menu = choose.nextState?.destinationMenu;
            if (choose.nextState === undefined || menu?.phase !== "choose")
              throw new Error("Expected source selection");
            const destination = menu.options?.find(
              (option) => option.destination["_tag"] === "profile",
            )?.destination;
            const seed = destination?.["_tag"] === "profile" ? destination.seed : undefined;
            if (seed === undefined) throw new Error("Missing adjusted copy seed");
            expect(seed.map((member) => member.address.name).sort()).toEqual([
              "extra",
              "review",
              "style",
            ]);
            const target = yield* destinations.open(choose.nextState, {
              _tag: "profile",
              sourcePath: f.source,
              profileName: "adjusted",
              create: true,
              seed,
            });
            if (target.editor === undefined) throw new Error("Missing profile copy destination");
            expect((yield* target.editor.apply([])).lines.join("\n")).toContain(
              "Saved profile adjusted",
            );
          }),
        );
        expect((yield* checkPaths([f.source])).summary.errors).toBe(0);
        expect(yield* readState(f.options)).toEqual(before);
      }),
  );
  for (const situation of [
    "declared",
    "derived",
    "missing",
    "duplicate",
    "reserved",
    "relocated",
  ] as const) {
    test.effect(`save, check and apply agree on ${situation} external names`, () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        yield* f.fs.makeDirectory(f.path.join(f.root, "git"));
        yield* f.write("team/tack.yaml", "version: 1\nname: team\ncommands: [{path: audit.md}]\n");
        yield* f.write("team/audit.md", "Audit\n");
        const team = yield* registerSource(f.options, { sourcePath: f.path.join(f.root, "team") });
        yield* mutateStateFixture(f.options, (state) => ({
          ...state,
          data: {
            ...state.data,
            userChoices: [
              {
                address: {
                  kind: "command",
                  name: "audit",
                  sourceRegistrationId: team.registration.id,
                },
                decision: "include",
              },
            ],
          },
        }));
        const request = {
          sourcePath: f.source,
          input: { user: true },
          name: "baseline",
          edit: false,
          apply: true,
        };
        expect((yield* runProfileSaveSelection(f.options, request)).saved).toBe(true);
        let companion = f.path.join(f.root, "team");
        const extras: string[] = [];
        if (situation === "derived")
          yield* f.write("team/tack.yaml", "version: 1\ncommands: [{path: audit.md}]\n");
        if (situation === "reserved")
          yield* f.write(
            "team/tack.yaml",
            "version: 1\nname: tack\ncommands: [{path: audit.md}]\n",
          );
        if (situation === "duplicate") {
          yield* f.write("duplicate/tack.yaml", "version: 1\nname: team\ncommands: []\n");
          yield* registerSource(f.options, { sourcePath: f.path.join(f.root, "duplicate") });
          extras.push(f.path.join(f.root, "duplicate"));
        }
        if (situation === "relocated") {
          companion = f.path.join(f.root, "another-checkout");
          yield* f.fs.rename(f.path.join(f.root, "team"), companion);
          yield* mutateStateFixture(f.options, (state) => ({
            ...state,
            data: {
              ...state.data,
              sources: state.data.sources.map((source) =>
                source.id === team.registration.id
                  ? { ...source, canonicalPath: companion }
                  : source,
              ),
            },
          }));
        }
        if (situation === "missing")
          yield* mutateStateFixture(f.options, (state) => ({
            ...state,
            data: {
              ...state.data,
              sources: state.data.sources.filter((source) => source.id !== team.registration.id),
            },
          }));
        const allowed = situation === "declared" || situation === "relocated";
        const copied = yield* runProfileSaveSelection(f.options, { ...request, name: "after" });
        expect(copied.saved, JSON.stringify(copied.plan.findings)).toBe(allowed);
        const checked = yield* checkPaths([
          f.path.join(f.source, "profiles/baseline.yaml"),
          ...(situation === "missing" ? [] : [companion]),
          ...extras,
        ]);
        expect(checked.summary.errors === 0, JSON.stringify(checked.findings)).toBe(allowed);
        const apply = yield* f.run(
          runProfileApply(f.options, { ...f.request, reference: "tools:baseline", apply: false }),
        );
        expect(apply.plan.refused).toBe(allowed === false);
        expect(yield* f.fs.exists(f.path.join(f.source, "profiles/after.yaml"))).toBe(allowed);
      }),
    );
  }
});
