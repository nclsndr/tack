import { skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { managedLinksOf } from "../../domain/links/link-record-schema.ts";
import { initializeState, readState, type StateOptions } from "../../services/state-store.ts";
import { disableAdapter } from "../maintenance/adapter-disablement.ts";
import { registerSource } from "../sources/source.ts";
import { runStatus } from "../status/status.ts";
import { enableAdapters } from "./agent.ts";
import { syncResources } from "../../../test/support/reconciliation.ts";
import { planReconciliation, reconciliationNamespaces } from "./reconciliation.ts";
import { agentAdapterDescriptor } from "../../domain/agents/agent-adapter.ts";
import type { SkillCatalogEntry } from "../../domain/sources/catalog-schema.ts";

/** A temporary user home with one registered source, and its isolated state. */
const withHome = <A, E, R>(
  use: (fixture: {
    readonly home: string;
    readonly options: StateOptions;
    readonly root: string;
    readonly skillDirectory: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-directory-alias-" }),
    );
    const home = path.join(root, "home");
    const source = path.join(root, "source");
    const skillDirectory = path.join(source, "skills", "valid");
    const options = {
      environment: { TACK_STATE_DIR: path.join(root, "state") },
      homeDirectory: home,
    } satisfies StateOptions;
    yield* fileSystem.makeDirectory(home, { recursive: true });
    yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(source, "tack.yaml"),
      "version: 1\nname: source\nskills:\n  - path: skills\n",
    );
    yield* fileSystem.writeFileString(
      path.join(skillDirectory, "SKILL.md"),
      skillText("valid", { tack: ["user-activation: default"], body: "" }),
    );
    yield* initializeState(options);
    yield* registerSource(options, { sourcePath: source });
    return yield* use({ home, options, root, skillDirectory });
  });

const reconcile = (options: StateOptions, home: string, apply: boolean) =>
  syncResources(options, {
    apply,
    cwd: home,
    includeOptional: false,
    selector: { _tag: "user" },
  });

const statusOf = (options: StateOptions, home: string) =>
  runStatus(options, { cwd: home, selector: { _tag: "user" } });

/** An alias layout: `.claude/skills` is a relative leaf alias for `.agents/skills`. */
const aliasClaudeToAgents = Effect.fnUntraced(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.join(home, ".agents", "skills"), { recursive: true });
  yield* fileSystem.makeDirectory(path.join(home, ".claude"), { recursive: true });
  yield* fileSystem.symlink(
    path.join("..", ".agents", "skills"),
    path.join(home, ".claude", "skills"),
  );
});

it.layer(LiveTestLayer)("agent directory aliases", (aliasIt) => {
  aliasIt.effect(
    "writes one physical link for a leaf alias and converges with status in agreement",
    () =>
      withHome(({ home, options, skillDirectory }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* aliasClaudeToAgents(home);
          yield* enableAdapters(options, ["claude", "codex"]);
          const physical = path.join(home, ".agents", "skills", "valid");

          const preview = yield* reconcile(options, home, false);
          const creates = preview.plan.units.flatMap((unit) =>
            unit.actions.map((action) => [unit.adapter, action._tag] as const),
          );
          expect(creates).toEqual([["codex", "link-create"]]);
          expect(preview.plan.units.flatMap((unit) => unit.conflicts)).toEqual([]);
          expect(preview.plan.units.map((unit) => unit.directoryAliases)).toEqual([
            [
              {
                alsoReachedBy: ["codex"],
                directory: path.join(home, ".claude", "skills"),
                kind: "skill",
                physicalDirectory: path.join(home, ".agents", "skills"),
              },
            ],
            [
              {
                alsoReachedBy: ["claude"],
                directory: path.join(home, ".agents", "skills"),
                kind: "skill",
                physicalDirectory: path.join(home, ".agents", "skills"),
              },
            ],
          ]);

          const applied = yield* reconcile(options, home, true);
          expect(applied.partial).toBe(false);
          expect((yield* fileSystem.readLink(physical)).startsWith("/")).toBe(false);
          expect(yield* fileSystem.realPath(physical)).toBe(skillDirectory);
          expect(yield* fileSystem.realPath(path.join(home, ".claude", "skills", "valid"))).toBe(
            skillDirectory,
          );
          const links = managedLinksOf((yield* readState(options)).data.links);
          expect(links.map((link) => [link.adapter, link.address.name])).toEqual([
            ["codex", "valid"],
          ]);

          // status agrees with the plan: both logical paths are one healthy install.
          const status = yield* statusOf(options, home);
          expect(
            status.destinations.map((destination) => [
              destination.adapter,
              destination._tag,
              destination.sharing?.role,
            ]),
          ).toEqual([
            ["codex", "matching", "writer"],
            ["claude", "matching", "shared"],
          ]);
          expect(status.destinations.every((destination) => destination._tag === "matching")).toBe(
            true,
          );

          // A second run is up to date: nothing to create, remove, or repair.
          const second = yield* reconcile(options, home, false);
          expect(second.plan.units.flatMap((unit) => [...unit.actions, ...unit.conflicts])).toEqual(
            [],
          );
          const rerun = yield* reconcile(options, home, true);
          expect(rerun.partial).toBe(false);
          expect(managedLinksOf((yield* readState(options)).data.links)).toHaveLength(1);
        }),
      ),
  );

  aliasIt.effect("lets a lone aliased adapter write through its alias", () =>
    withHome(({ home, options, skillDirectory }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* aliasClaudeToAgents(home);
        yield* enableAdapters(options, ["claude"]);

        const applied = yield* reconcile(options, home, true);

        expect(applied.partial).toBe(false);
        expect(yield* fileSystem.realPath(path.join(home, ".agents", "skills", "valid"))).toBe(
          skillDirectory,
        );
        expect(
          managedLinksOf((yield* readState(options)).data.links).map((link) => link.adapter),
        ).toEqual(["claude"]);
        expect(
          (yield* statusOf(options, home)).destinations.map((destination) => destination._tag),
        ).toEqual(["matching"]);
        expect(
          (yield* reconcile(options, home, false)).plan.units.flatMap((unit) => unit.actions),
        ).toEqual([]);
      }),
    ),
  );

  aliasIt.effect("keeps the existing writer when a second adapter joins the alias", () =>
    withHome(({ home, options }) =>
      Effect.gen(function* () {
        yield* aliasClaudeToAgents(home);
        yield* enableAdapters(options, ["claude"]);
        yield* reconcile(options, home, true);
        yield* enableAdapters(options, ["claude", "codex"]);

        const preview = yield* reconcile(options, home, false);

        expect(preview.plan.units.flatMap((unit) => [...unit.actions, ...unit.conflicts])).toEqual(
          [],
        );
        const status = yield* statusOf(options, home);
        expect(
          status.destinations.map((destination) => [destination.adapter, destination._tag]),
        ).toEqual([
          ["codex", "matching"],
          ["claude", "matching"],
        ]);
      }),
    ),
  );

  aliasIt.effect("keeps a dangling alias, a file alias, and an outside alias as conflicts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cases = [
        {
          name: "dangling",
          prepare: (_root: string) => Effect.succeed(path.join("..", "missing", "skills")),
        },
        {
          name: "file",
          prepare: (root: string) =>
            fileSystem
              .writeFileString(path.join(root, "home", "a-file"), "not a directory")
              .pipe(Effect.as(path.join("..", "a-file"))),
        },
        {
          name: "outside",
          prepare: (root: string) =>
            fileSystem
              .makeDirectory(path.join(root, "outside", "skills"), { recursive: true })
              .pipe(Effect.as(path.join("..", "..", "outside", "skills"))),
        },
      ];
      for (const aliasCase of cases) {
        yield* withHome(({ home, options, root }) =>
          Effect.gen(function* () {
            const text = yield* aliasCase.prepare(root);
            yield* fileSystem.makeDirectory(path.join(home, ".claude"), { recursive: true });
            yield* fileSystem.symlink(text, path.join(home, ".claude", "skills"));
            yield* enableAdapters(options, ["claude", "codex"]);

            const preview = yield* reconcile(options, home, false);
            const claude = preview.plan.units.find((unit) => unit.adapter === "claude");
            expect(
              claude?.conflicts.map((conflict) => conflict._tag),
              aliasCase.name,
            ).toEqual(["destination-directory-conflict"]);
            expect(claude?.actions, aliasCase.name).toEqual([]);
            expect(claude?.directoryAliases, aliasCase.name).toBeUndefined();
            // The other adapter is unaffected and still links normally.
            const codex = preview.plan.units.find((unit) => unit.adapter === "codex");
            expect(codex?.actions.map((action) => action._tag)).toContain("link-create");

            const applied = yield* reconcile(options, home, true);
            expect(applied.partial, aliasCase.name).toBe(true);
            expect(yield* fileSystem.readLink(path.join(home, ".claude", "skills"))).toBe(text);
          }),
        );
      }
    }),
  );

  aliasIt.effect("keeps an ordinary symlinked ancestor on its independent planning", () =>
    withHome(({ home, options, root, skillDirectory }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(root, "elsewhere", "skills"), {
          recursive: true,
        });
        yield* fileSystem.symlink(path.join(root, "elsewhere"), path.join(home, ".claude"));
        yield* enableAdapters(options, ["claude"]);

        const applied = yield* reconcile(options, home, true);

        expect(applied.partial).toBe(false);
        expect(yield* fileSystem.realPath(path.join(root, "elsewhere", "skills", "valid"))).toBe(
          skillDirectory,
        );
        const [unit] = (yield* reconcile(options, home, false)).plan.units;
        expect(unit?.directoryAliases).toBeUndefined();
      }),
    ),
  );

  aliasIt.effect("keeps two desired resources with one name a collision on the alias", () =>
    withHome(({ home, root }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* aliasClaudeToAgents(home);
        const entry = (owner: "private" | "shared") =>
          ({
            activation: "default",
            address: {
              kind: "skill",
              name: "valid",
              sourceRegistrationId:
                owner === "shared"
                  ? "00000000-0000-4000-8000-000000000001"
                  : "00000000-0000-4000-8000-000000000002",
            },
            dependencies: [],
            description: "valid description",
            directoryPath: path.join(root, owner, "valid"),
            frontmatter: { description: "valid description", name: "valid" },
            projects: [],
            skillFilePath: path.join(root, owner, "valid", "SKILL.md"),
            sourcePath: path.join(root, owner),
            sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
          }) satisfies SkillCatalogEntry;
        const entries = [entry("shared"), entry("private")];
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("claude"), agentAdapterDescriptor("codex")],
          catalogEntries: entries,
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [
              {
                namespace: { _tag: "user" },
                resolution: {
                  groups: entries.map((member) => ({
                    _tag: "selected" as const,
                    members: [member.address],
                  })),
                  optionalSkips: [],
                  requestBlockers: [],
                },
              },
            ],
            [{ _tag: "user", canonicalPath: home }],
          ),
        });

        expect(plan.units.map((unit) => unit.collisions.length)).toEqual([1, 1]);
        expect(plan.units.flatMap((unit) => [...unit.actions, ...unit.conflicts])).toEqual([]);
      }),
    ),
  );

  aliasIt.effect(
    "cleans up only with evidence, names the sharing, and restores a still-desired link",
    () =>
      withHome(({ home, options, skillDirectory }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* aliasClaudeToAgents(home);
          yield* enableAdapters(options, ["claude", "codex"]);
          yield* reconcile(options, home, true);
          const physical = path.join(home, ".agents", "skills", "valid");

          // claude holds no evidence, so disabling it cannot remove codex's link.
          const claudeOff = yield* disableAdapter(options, "claude", { apply: true });
          expect(claudeOff.plan.removal.actions).toEqual([]);
          expect(yield* fileSystem.realPath(physical)).toBe(skillDirectory);
          expect(
            managedLinksOf((yield* readState(options)).data.links).map((link) => link.adapter),
          ).toEqual(["codex"]);

          // codex owns the link: its removal is authorized and names the other adapter reaching it.
          yield* enableAdapters(options, ["claude", "codex"]);
          const preview = yield* disableAdapter(options, "codex", { apply: false });
          expect(preview.plan.removal.actions).toMatchObject([
            { _tag: "remove", alsoReachedBy: ["claude"], destinationPath: physical },
          ]);
          const applied = yield* disableAdapter(options, "codex", { apply: true });
          expect(applied.applied?.removal.actions[0]?._tag).toBe("applied");
          expect(yield* fileSystem.exists(physical)).toBe(false);
          expect(managedLinksOf((yield* readState(options)).data.links)).toEqual([]);

          // The remaining adapter still wants the link; the next sync restores it through the alias.
          const restored = yield* reconcile(options, home, true);
          expect(restored.partial).toBe(false);
          expect(yield* fileSystem.realPath(physical)).toBe(skillDirectory);
          expect(
            managedLinksOf((yield* readState(options)).data.links).map((link) => link.adapter),
          ).toEqual(["claude"]);
        }),
      ),
  );
});
