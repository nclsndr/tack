import { skillText } from "../../../test/support/source-tree.ts";
import { fakeGit } from "../../../test/support/fake-git.ts";
import { writeUnder } from "../../../test/support/source-tree.ts";
import { setChoice } from "../../../test/support/snapshot-helpers.ts";
import {
  agentLink,
  managedLinksOf,
  pendingRemovalsOf,
} from "../../domain/links/link-record-schema.ts";
import { allChoices } from "../../domain/state/state-intent.ts";
import { mutateStateFixture, stateOptionsAt } from "../../../test/support/state-fixture.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { initializeState, readState, type StateOptions } from "../../services/state-store.ts";
import { registerSource } from "../sources/source.ts";

import { enableAdapters } from "./agent.ts";
import { runStatus } from "../status/status.ts";
import { cleanManagedLinks, resetTack } from "../removal/selected-removal.ts";
import { disableAdapter } from "../removal/adapter-disablement.ts";
import { runProjectRefreshCommand } from "../refresh/project-refresh.ts";
import { ManagedLinkEvidenceSchema } from "../../domain/links/managed-link-schema.ts";
import { applyReconciliationPlan, syncResources } from "../../../test/support/reconciliation.ts";
import { Git } from "../../services/git.ts";

const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "tack-unified-links-" }),
  );
  const home = path.join(root, "home");
  const source = path.join(root, "source");
  const statePath = path.join(root, "state", "state.json");
  const options: StateOptions = stateOptionsAt(path.dirname(statePath), home);
  const write = writeUnder(source);
  yield* fs.makeDirectory(home);
  yield* write(
    "tack.yaml",
    "version: 1\nname: source\nskills:\n  - path: skills\ncommands:\n  - path: commands\ncontext:\n  - path: context\n",
  );
  yield* write(
    "commands/review.md",
    "---\nmetadata:\n  tack: |\n    version: 1\n    user-activation: default\n---\nReview\n",
  );
  yield* write(
    "skills/review/SKILL.md",
    skillText("review", { description: "Review", tack: ["user-activation: default"], body: "" }),
  );
  yield* write("context/notes/design.md", "Context\n");
  yield* initializeState(options);
  yield* registerSource(options, { sourcePath: source });
  const sourceRegistrationId = (yield* readState(options)).data.sources[0]?.id ?? "";
  yield* enableAdapters(options, ["claude", "codex", "cursor"]);
  const reconcile = (apply = true) =>
    syncResources(options, {
      apply,
      cwd: home,
      selector: { _tag: "user" },
      includeOptional: false,
    });
  const command = path.join(home, ".cursor", "commands", "review.md");
  const skill = path.join(home, ".cursor", "skills", "review");
  return {
    fs,
    path,
    root,
    home,
    source,
    statePath,
    options,
    sourceRegistrationId,
    write,
    reconcile,
    command,
    skill,
  };
});

it("rejects persisted command ownership for adapters without command delivery", () => {
  const evidence = {
    adapter: "codex",
    address: {
      kind: "command",
      name: "review",
      sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
    },
    sourceDirectoryPath: "/source/commands/review.md",
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
    target: { _tag: "user", canonicalPath: "/home" },
  };
  expect(() => Schema.decodeUnknownSync(ManagedLinkEvidenceSchema)(evidence)).toThrow();
  expect(
    Schema.decodeUnknownSync(ManagedLinkEvidenceSchema)({ ...evidence, adapter: "cursor" }),
  ).toMatchObject({ address: { kind: "command" } });
});

it.layer(LiveTestLayer)("unified resource links", (test) => {
  test.effect(
    "previews and applies separate command and skill links, reports undelivered resources, and cleans both",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* setChoice(f.options, {
          namespace: { _tag: "user" },
          address: {
            kind: "context",
            name: "notes/design.md",
            sourceRegistrationId: f.sourceRegistrationId,
          },
          decision: "include",
        });
        const before = yield* f.fs.readFileString(f.statePath);
        const preview = yield* f.reconcile(false);
        expect(
          preview.plan.units
            .flatMap((unit) => unit.actions)
            .filter((action) => action._tag === "link-create"),
        ).toHaveLength(4);
        expect(yield* f.fs.readFileString(f.statePath)).toBe(before);
        expect(yield* f.fs.exists(f.path.dirname(f.command))).toBe(false);
        const applied = yield* f.reconcile();
        expect(applied.partial).toBe(false);
        expect(applied.plan).toEqual(preview.plan);
        expect(yield* f.fs.readLink(f.command)).not.toMatch(/^\//);
        expect(yield* f.fs.realPath(f.command)).toBe(
          f.path.join(f.source, "commands", "review.md"),
        );
        expect(yield* f.fs.realPath(f.skill)).toBe(f.path.join(f.source, "skills", "review"));
        expect(yield* f.fs.exists(f.path.join(f.home, ".codex"))).toBe(false);
        expect(yield* f.fs.exists(f.path.join(f.home, ".claude", "commands"))).toBe(false);
        const status = yield* runStatus(f.options, { cwd: f.home, selector: { _tag: "user" } });
        expect(status.destinations).toHaveLength(4);
        expect(status.destinations.every((destination) => destination._tag === "matching")).toBe(
          true,
        );
        expect(status.namespaces[0]?.undelivered).toMatchObject([
          {
            address: expect.objectContaining({ kind: "command", name: "review" }),
            adapter: "claude",
            reason: "capability-unsupported",
          },
          {
            address: expect.objectContaining({ kind: "command", name: "review" }),
            adapter: "codex",
            reason: "capability-unsupported",
          },
          {
            address: {
              kind: "context",
              name: "notes/design.md",
              sourceRegistrationId: f.sourceRegistrationId,
            },
            reason: "context-not-delivered",
          },
        ]);
        yield* cleanManagedLinks(f.options, {
          apply: true,
          cwd: f.home,
          selector: { _tag: "user" },
        });
        expect(yield* f.fs.exists(f.command)).toBe(false);
        expect(yield* f.fs.exists(f.skill)).toBe(false);
        expect(yield* f.fs.exists(f.path.dirname(f.command))).toBe(true);
        expect(yield* f.fs.exists(f.path.join(f.source, "commands", "review.md"))).toBe(true);
        const retained = yield* readState(f.options);
        expect(managedLinksOf(retained.data.links)).toEqual([]);
        expect(allChoices(retained)).toHaveLength(1);
      }),
  );

  test.effect(
    "removes only verified command collision links while preserving a same-name skill",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.reconcile();
        yield* f.write(
          "private/tack.yaml",
          "version: 1\nname: private\ncommands:\n  - path: commands\n",
        );
        yield* f.write(
          "private/commands/review.md",
          "---\nmetadata:\n  tack: |\n    version: 1\n    user-activation: default\n---\nPrivate review\n",
        );
        yield* registerSource(f.options, { sourcePath: f.path.join(f.source, "private") });
        const collision = yield* f.reconcile();
        expect(collision.partial).toBe(true);
        expect(
          collision.plan.units.find((unit) => unit.adapter === "cursor")?.collisions,
        ).toMatchObject([
          {
            name: "review",
            addresses: [{ kind: "command" }, { kind: "command" }],
          },
        ]);
        expect(yield* f.fs.exists(f.command)).toBe(false);
        expect(yield* f.fs.exists(f.skill)).toBe(true);
        yield* f.fs.writeFileString(f.command, "operator-owned");
        yield* f.reconcile();
        expect(yield* f.fs.readFileString(f.command)).toBe("operator-owned");
      }),
  );

  test.effect.each(["file", "directory", "absolute-link", "relative-link"] as const)(
    "preserves foreign %s at a command destination and still installs skills",
    (kind) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.makeDirectory(f.path.dirname(f.command), { recursive: true });
        const source = f.path.join(f.source, "commands", "review.md");
        if (kind === "file") yield* f.fs.writeFileString(f.command, "foreign");
        else if (kind === "directory") yield* f.fs.makeDirectory(f.command);
        // The relative link resolves to the source but is not byte-identical to Tack's, so it is foreign.
        else
          yield* f.fs.symlink(
            kind === "absolute-link"
              ? source
              : `./${f.path.relative(f.path.dirname(f.command), source)}`,
            f.command,
          );
        const result = yield* f.reconcile();
        expect(result.partial).toBe(true);
        expect(
          result.plan.units.find((unit) => unit.adapter === "cursor")?.conflicts,
        ).toMatchObject([{ _tag: "foreign-destination", destinationPath: f.command }]);
        expect(yield* f.fs.exists(f.skill)).toBe(true);
        yield* cleanManagedLinks(f.options, {
          apply: true,
          cwd: f.home,
          selector: { _tag: "user" },
        });
        expect(yield* f.fs.exists(f.command)).toBe(true);
      }),
  );

  test.effect(
    "keeps a drifted command's reset evidence until a later reset can remove its exact link",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.reconcile();
        yield* f.fs.remove(f.command);
        yield* f.fs.symlink(
          f.path.relative(
            f.path.dirname(f.command),
            f.path.join(f.source, "context", "notes", "design.md"),
          ),
          f.command,
        );
        const reset = yield* resetTack(f.options, { apply: true });
        expect(reset.applied?.pendingRemovals).toHaveLength(1);
        const retained = yield* readState(f.options);
        expect(pendingRemovalsOf(retained.data.links)[0]).toMatchObject({
          cause: "reset",
          evidence: { address: { kind: "command", name: "review" } },
        });
        expect(yield* f.fs.exists(f.command)).toBe(true);
        yield* f.fs.remove(f.command);
        yield* f.fs.symlink(
          f.path.relative(
            f.path.dirname(f.command),
            f.path.join(f.source, "commands", "review.md"),
          ),
          f.command,
        );
        yield* resetTack(f.options, { apply: true });
        expect(yield* f.fs.exists(f.command)).toBe(false);
        expect(yield* f.fs.exists(f.statePath)).toBe(false);
        expect(yield* f.fs.exists(f.path.dirname(f.command))).toBe(true);
      }),
  );

  test.effect("keeps command-directory conflicts independent of healthy skill delivery", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.makeDirectory(f.path.join(f.home, ".cursor"));
      yield* f.fs.writeFileString(f.path.dirname(f.command), "foreign directory replacement");
      const result = yield* f.reconcile();
      expect(result.partial).toBe(true);
      expect(yield* f.fs.exists(f.skill)).toBe(true);
      expect(yield* f.fs.readFileString(f.path.dirname(f.command))).toBe(
        "foreign directory replacement",
      );
    }),
  );

  test.effect("does not suppress skills when creating the command directory fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* provideTestFileSystem(f.reconcile(), {
        ...f.fs,
        makeDirectory: (directory, options) =>
          directory === f.path.dirname(f.command)
            ? Effect.fail(
                PlatformError.badArgument({
                  module: "unified-resource-test",
                  method: "makeDirectory",
                  description: "command directory denied",
                }),
              )
            : f.fs.makeDirectory(directory, options),
      });
      expect(result.partial).toBe(true);
      expect(yield* f.fs.exists(f.command)).toBe(false);
      expect(yield* f.fs.exists(f.skill)).toBe(true);
      expect((yield* f.reconcile()).partial).toBe(false);
      expect(yield* f.fs.exists(f.command)).toBe(true);
    }),
  );

  test.effect("recovers a prepared command link without adopting foreign links", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const preview = yield* f.reconcile(false);
      const action = preview.plan.units
        .flatMap((unit) => unit.actions)
        .find(
          (candidate) =>
            candidate._tag === "link-create" && candidate.evidence.address.kind === "command",
        );
      if (action === undefined || action._tag !== "link-create")
        throw new Error("Expected command creation");
      yield* f.fs.makeDirectory(f.path.dirname(f.command), { recursive: true });
      yield* f.fs.symlink(action.relativeTarget, f.command);
      yield* mutateStateFixture(f.options, (state) => ({
        ...state,
        data: { ...state.data, journal: [{ _tag: "create", link: agentLink(action.evidence) }] },
      }));
      expect((yield* f.reconcile()).partial).toBe(false);
      const state = yield* readState(f.options);
      expect(state.data.journal).toBeUndefined();
      expect(
        managedLinksOf(state.data.links).filter((evidence) => evidence.address.kind === "command"),
      ).toHaveLength(1);
      expect((yield* f.reconcile()).plan.units.flatMap((unit) => unit.actions)).toEqual([]);
    }),
  );

  test.effect("rejects a command file replaced by a directory between planning and apply", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const preview = yield* f.reconcile(false);
      const source = f.path.join(f.source, "commands", "review.md");
      yield* f.fs.remove(source);
      yield* f.fs.makeDirectory(source);
      const result = yield* applyReconciliationPlan(f.options, preview.plan);
      expect(result.units.flatMap((unit) => unit.actions)).toContainEqual(
        expect.objectContaining({
          _tag: "failed",
          action: expect.objectContaining({ destinationPath: f.command }),
        }),
      );
      expect(yield* f.fs.exists(f.command)).toBe(false);
      expect(yield* f.fs.exists(f.skill)).toBe(true);
    }),
  );

  test.effect(
    "refreshes project roots and safely removes commands from a reachable retired root",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const anchor = f.path.join(f.root, "git-common");
        const activeRoot = f.path.join(f.root, "active");
        const retiredRoot = f.path.join(f.root, "retired");
        for (const directory of [anchor, activeRoot, retiredRoot])
          yield* f.fs.makeDirectory(directory);
        yield* mutateStateFixture(f.options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              { name: "project", gitCommonDirectory: anchor, roots: [activeRoot, retiredRoot] },
            ],
          },
        }));
        const git = fakeGit(anchor, [{ path: activeRoot }]);
        // Out of the user's folder, so the project links the command itself.
        yield* setChoice(f.options, {
          namespace: { _tag: "user" },
          address: {
            kind: "command",
            name: "review",
            sourceRegistrationId: f.sourceRegistrationId,
          },
          decision: "exclude",
        });
        yield* syncResources(f.options, {
          apply: true,
          cwd: activeRoot,
          selector: { _tag: "project", projectName: "project" },
          includeOptional: false,
        }).pipe(Effect.provideService(Git, git));
        const retiredCommand = f.path.join(retiredRoot, ".cursor", "commands", "review.md");
        expect(yield* f.fs.exists(retiredCommand)).toBe(true);
        yield* runProjectRefreshCommand(f.options, {
          apply: true,
          scope: { _tag: "project", projectName: "project" },
        }).pipe(Effect.provideService(Git, git));
        expect(yield* f.fs.exists(retiredCommand)).toBe(false);
        expect(yield* f.fs.exists(f.path.dirname(retiredCommand))).toBe(true);
        expect(
          yield* f.fs.exists(f.path.join(activeRoot, ".cursor", "commands", "review.md")),
        ).toBe(true);
        expect((yield* readState(f.options)).data.projects?.[0]?.roots).toEqual([activeRoot]);
      }),
  );

  test.effect(
    "links skills and commands into the OpenCode and Pi folders and disables each one alone",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* enableAdapters(f.options, ["opencode", "pi"]);
        const native = {
          opencode: {
            command: f.path.join(f.home, ".config", "opencode", "commands", "review.md"),
            skill: f.path.join(f.home, ".config", "opencode", "skills", "review"),
          },
          pi: {
            command: f.path.join(f.home, ".pi", "agent", "prompts", "review.md"),
            skill: f.path.join(f.home, ".pi", "agent", "skills", "review"),
          },
        };
        const entries = [native.opencode, native.pi].flatMap((paths) => [
          { link: paths.command, source: f.path.join(f.source, "commands", "review.md") },
          { link: paths.skill, source: f.path.join(f.source, "skills", "review") },
        ]);

        const preview = yield* f.reconcile(false);
        expect(
          preview.plan.units
            .filter((unit) => unit.adapter === "opencode" || unit.adapter === "pi")
            .flatMap((unit) => unit.actions)
            .flatMap((action) => (action._tag === "link-create" ? [action.destinationPath] : []))
            .sort(),
        ).toEqual(entries.map((entry) => entry.link).sort());
        expect(yield* f.fs.exists(f.path.join(f.home, ".config"))).toBe(false);
        expect(yield* f.fs.exists(f.path.join(f.home, ".pi"))).toBe(false);

        expect((yield* f.reconcile()).partial).toBe(false);
        for (const entry of entries) {
          expect(yield* f.fs.readLink(entry.link)).not.toMatch(/^\//);
          expect(yield* f.fs.realPath(entry.link)).toBe(entry.source);
        }
        expect((yield* f.reconcile()).plan.units.flatMap((unit) => unit.actions)).toEqual([]);

        yield* disableAdapter(f.options, "opencode", { apply: true });
        expect(yield* f.fs.exists(native.opencode.command)).toBe(false);
        expect(yield* f.fs.exists(native.opencode.skill)).toBe(false);
        expect(yield* f.fs.exists(native.pi.command)).toBe(true);
        expect(yield* f.fs.exists(native.pi.skill)).toBe(true);
        expect(yield* f.fs.exists(f.command)).toBe(true);
        expect((yield* readState(f.options)).data.enabledAdapters).toEqual([
          "claude",
          "codex",
          "cursor",
          "pi",
        ]);
      }),
  );

  test.effect(
    "links skills into the Cline, Copilot and Gemini folders and commands into Cline's workflows only",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* enableAdapters(f.options, ["cline", "copilot", "gemini"]);
        const command = f.path.join(f.source, "commands", "review.md");
        const skill = f.path.join(f.source, "skills", "review");
        const entries = [
          { link: f.path.join(f.home, ".cline", "skills", "review"), source: skill },
          {
            link: f.path.join(f.home, "Documents", "Cline", "Workflows", "review.md"),
            source: command,
          },
          { link: f.path.join(f.home, ".copilot", "skills", "review"), source: skill },
          { link: f.path.join(f.home, ".gemini", "skills", "review"), source: skill },
        ];
        const added = new Set(["cline", "copilot", "gemini"]);

        const preview = yield* f.reconcile(false);
        const units = preview.plan.units.filter((unit) => added.has(unit.adapter));
        expect(units.map((unit) => [unit.adapter, unit.delivery.command])).toEqual([
          ["cline", "delivered"],
          ["copilot", "unsupported"],
          ["gemini", "unsupported"],
        ]);
        expect(
          units
            .flatMap((unit) => unit.actions)
            .flatMap((action) => (action._tag === "link-create" ? [action.destinationPath] : []))
            .sort(),
        ).toEqual(entries.map((entry) => entry.link).sort());

        expect((yield* f.reconcile()).partial).toBe(false);
        for (const entry of entries) {
          expect(yield* f.fs.readLink(entry.link)).not.toMatch(/^\//);
          expect(yield* f.fs.realPath(entry.link)).toBe(entry.source);
        }
        expect(yield* f.fs.exists(f.path.join(f.home, ".copilot", "commands"))).toBe(false);
        expect(yield* f.fs.exists(f.path.join(f.home, ".gemini", "commands"))).toBe(false);
      }),
  );

  test.effect("links skills and commands into the OpenCode and Pi folders of a project root", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const anchor = f.path.join(f.root, "git-common");
      const projectRoot = f.path.join(f.root, "app");
      for (const directory of [anchor, projectRoot]) yield* f.fs.makeDirectory(directory);
      yield* mutateStateFixture(f.options, (state) => ({
        ...state,
        data: {
          ...state.data,
          projects: [{ name: "app", gitCommonDirectory: anchor, roots: [projectRoot] }],
        },
      }));
      const git = fakeGit(anchor, [{ path: projectRoot }]);
      // Out of the user's folders, so the project links both resources itself.
      for (const kind of ["command", "skill"] as const)
        yield* setChoice(f.options, {
          namespace: { _tag: "user" },
          address: { kind, name: "review", sourceRegistrationId: f.sourceRegistrationId },
          decision: "exclude",
        });
      for (const kind of ["command", "skill"] as const)
        yield* setChoice(f.options, {
          namespace: { _tag: "project", projectName: "app" },
          address: { kind, name: "review", sourceRegistrationId: f.sourceRegistrationId },
          decision: "include",
        });
      yield* enableAdapters(f.options, ["opencode", "pi"]);

      const result = yield* syncResources(f.options, {
        adapterOverride: ["opencode", "pi"],
        apply: true,
        cwd: projectRoot,
        selector: { _tag: "project", projectName: "app" },
        includeOptional: false,
      }).pipe(Effect.provideService(Git, git));

      expect(result.partial).toBe(false);
      expect(result.plan.units.map((unit) => unit.adapter)).toEqual(["opencode", "pi"]);
      const command = f.path.join(f.source, "commands", "review.md");
      const skill = f.path.join(f.source, "skills", "review");
      for (const [link, source] of [
        [f.path.join(projectRoot, ".opencode", "commands", "review.md"), command],
        [f.path.join(projectRoot, ".opencode", "skills", "review"), skill],
        [f.path.join(projectRoot, ".pi", "prompts", "review.md"), command],
        [f.path.join(projectRoot, ".pi", "skills", "review"), skill],
      ] as const)
        expect(yield* f.fs.realPath(link)).toBe(source);
      expect(yield* f.fs.exists(f.path.join(projectRoot, ".cursor"))).toBe(false);
    }),
  );
});
