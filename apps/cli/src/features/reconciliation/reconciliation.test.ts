import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import {
  agentAdapterDescriptor,
  agentAdapterDescriptors,
} from "../../domain/agents/agent-adapter.ts";
import {
  type ManagedLinkEvidence,
  type ManagedLinkTarget,
} from "../../domain/links/managed-link-schema.ts";
import {
  ReconciliationPlanSchema,
  planReconciliation,
  reconciliationNamespaces,
  type NamespaceDependencyResolution,
} from "./reconciliation.ts";
import type { DependencyResolution } from "../../domain/choices/dependency-resolution.ts";
import type { ChoiceNamespace } from "../../domain/choices/choice-schema.ts";
import type { CatalogEntryOf, SkillCatalogEntry } from "../../domain/sources/catalog-schema.ts";
import { Destination } from "../../services/destination.ts";
import { makeDestinationService } from "../../platform/filesystem/destination-observation.ts";

/** The address of a skill, as a catalog entry carries it. */
type SkillAddress = SkillCatalogEntry["address"];

const registrationId = "00000000-0000-4000-8000-000000000001";
const userNamespace = { _tag: "user" } satisfies ChoiceNamespace;

const address = (name: string, owner: "shared" | "private" = "shared") =>
  ({
    kind: "skill",
    name,
    sourceRegistrationId:
      owner === "shared" ? registrationId : "00000000-0000-4000-8000-000000000002",
  }) satisfies SkillAddress;

const catalogEntry = (
  name: string,
  sourceDirectoryPath: string,
  owner: "shared" | "private" = "shared",
) =>
  ({
    activation: "default",
    address: address(name, owner),
    dependencies: [],
    description: `${name} description`,
    directoryPath: sourceDirectoryPath,
    frontmatter: { description: `${name} description`, name },
    projects: [],
    skillFilePath: `${sourceDirectoryPath}/SKILL.md`,
    sourcePath: `/sources/${owner}`,
    sourceRegistrationId: registrationId,
  }) satisfies SkillCatalogEntry;

const targetUser = (canonicalPath: string) =>
  ({ _tag: "user", canonicalPath }) satisfies ManagedLinkTarget;

const targetProject = (canonicalPath: string, projectName = "project") =>
  ({ _tag: "project-root", canonicalPath, projectName }) satisfies ManagedLinkTarget;

const resolution = (addresses: ReadonlyArray<SkillAddress>): DependencyResolution => ({
  groups: addresses.map((member) => ({ _tag: "selected", members: [member] })),
  optionalSkips: [],
  requestBlockers: [],
});

const namespaceResolution = (namespace: ChoiceNamespace, addresses: ReadonlyArray<SkillAddress>) =>
  ({ namespace, resolution: resolution(addresses) }) satisfies NamespaceDependencyResolution;

const evidence = (
  adapter: ManagedLinkEvidence["adapter"],
  target: ManagedLinkTarget,
  entry: SkillCatalogEntry,
) =>
  ({
    adapter,
    address: entry.address,
    sourceDirectoryPath: entry.directoryPath,
    sourceRegistrationId: entry.sourceRegistrationId,
    target,
  }) satisfies ManagedLinkEvidence;

it.layer(LiveTestLayer)("reconciliation planning", (planningIt) => {
  planningIt.effect("derives all target and adapter layouts and relative link creations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const source = path.join(root, "source", "alpha");
        const home = path.join(root, "home");
        const project = path.join(root, "project");
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(home, { recursive: true });
        yield* fileSystem.makeDirectory(project, { recursive: true });
        const entry = catalogEntry("alpha", source);
        const before = yield* fileSystem.readDirectory(root);

        const plan = yield* planReconciliation({
          adapters: agentAdapterDescriptors,
          catalogEntries: [entry],
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [
              namespaceResolution(userNamespace, [entry.address]),
              namespaceResolution({ _tag: "project", projectName: "project" }, [entry.address]),
            ],
            [targetUser(home), targetProject(project)],
          ),
        });

        const skillDirectories = [
          path.join(project, ".claude", "skills"),
          path.join(project, ".agents", "skills"),
          path.join(project, ".cursor", "skills"),
          path.join(project, ".opencode", "skills"),
          path.join(project, ".pi", "skills"),
          path.join(home, ".claude", "skills"),
          path.join(home, ".agents", "skills"),
          path.join(home, ".cursor", "skills"),
          path.join(home, ".config", "opencode", "skills"),
          path.join(home, ".pi", "agent", "skills"),
        ];
        const skillsOnly = { command: "unsupported", skill: "delivered" } as const;
        const skillsAndCommands = { command: "delivered", skill: "delivered" } as const;
        expect(
          plan.units.map((unit) => [unit.target.canonicalPath, unit.adapter, unit.delivery]),
        ).toEqual([
          [project, "claude", skillsOnly],
          [project, "codex", skillsOnly],
          [project, "cursor", skillsAndCommands],
          [project, "opencode", skillsAndCommands],
          [project, "pi", skillsAndCommands],
          [home, "claude", skillsOnly],
          [home, "codex", skillsOnly],
          [home, "cursor", skillsAndCommands],
          [home, "opencode", skillsAndCommands],
          [home, "pi", skillsAndCommands],
        ]);
        expect(plan.units.map((unit) => unit.actions[0])).toEqual(
          skillDirectories.map((directoryPath) => ({ _tag: "directory-create", directoryPath })),
        );
        expect(plan.units.some((unit) => "capability" in unit)).toBe(false);
        expect(
          plan.units.flatMap((unit) =>
            unit.actions.flatMap((action) =>
              action._tag === "link-create" ? [action.relativeTarget] : [],
            ),
          ),
        ).toEqual(skillDirectories.map((directory) => path.relative(directory, source)));
        expect(yield* fileSystem.readDirectory(root)).toEqual(before);
        for (const skillDirectory of skillDirectories) {
          expect(yield* fileSystem.exists(skillDirectory)).toBe(false);
        }
        expect(Schema.decodeUnknownSync(ReconciliationPlanSchema)(plan)).toEqual(plan);
      }),
    ),
  );

  planningIt.effect(
    "keeps a verified relative managed link and retires absent stale evidence",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "tack-plan-test-",
          });
          const root = yield* fileSystem.realPath(temporaryRoot);
          const home = path.join(root, "home");
          const skillDirectory = path.join(home, ".cursor", "skills");
          const selectedSource = path.join(root, "source", "selected");
          const staleSource = path.join(root, "source", "stale");
          const returningSource = path.join(root, "source", "returning");
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.makeDirectory(selectedSource, { recursive: true });
          yield* fileSystem.makeDirectory(staleSource, { recursive: true });
          yield* fileSystem.makeDirectory(returningSource, { recursive: true });
          const selected = catalogEntry("selected", selectedSource);
          const stale = catalogEntry("stale", staleSource);
          const returning = catalogEntry("returning", returningSource);
          yield* fileSystem.symlink(
            path.relative(skillDirectory, selectedSource),
            path.join(skillDirectory, "selected"),
          );

          const plan = yield* planReconciliation({
            adapters: [agentAdapterDescriptor("cursor")],
            catalogEntries: [selected, stale, returning],
            managedLinks: [
              evidence("cursor", targetUser(home), selected),
              evidence("cursor", targetUser(home), stale),
              evidence("cursor", targetUser(home), returning),
            ],
            namespaces: reconciliationNamespaces(
              [namespaceResolution(userNamespace, [selected.address, returning.address])],
              [targetUser(home)],
            ),
          });

          expect(plan.units[0]?.actions).toMatchObject([
            { _tag: "evidence-retire", evidence: { address: { name: "stale" } } },
            { _tag: "link-create", evidence: { address: { name: "returning" } } },
          ]);
          expect(plan.units[0]?.conflicts).toEqual([]);
        }),
      ),
  );

  planningIt.effect("removes verified stale links and rewires a relocated selected source", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const home = path.join(root, "home");
        const skillDirectory = path.join(home, ".cursor", "skills");
        const oldSource = path.join(root, "source", "old");
        const newSource = path.join(root, "source", "new");
        const staleSource = path.join(root, "source", "stale");
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.makeDirectory(oldSource, { recursive: true });
        yield* fileSystem.makeDirectory(newSource, { recursive: true });
        yield* fileSystem.makeDirectory(staleSource, { recursive: true });
        const old = catalogEntry("moving", oldSource);
        const moved = catalogEntry("moving", newSource);
        const stale = catalogEntry("stale", staleSource);
        yield* fileSystem.symlink(
          path.relative(skillDirectory, oldSource),
          path.join(skillDirectory, "moving"),
        );
        yield* fileSystem.symlink(
          path.relative(skillDirectory, staleSource),
          path.join(skillDirectory, "stale"),
        );

        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [moved],
          managedLinks: [
            evidence("cursor", targetUser(home), old),
            evidence("cursor", targetUser(home), stale),
          ],
          namespaces: reconciliationNamespaces(
            [namespaceResolution(userNamespace, [moved.address])],
            [targetUser(home)],
          ),
        });

        expect(plan.units[0]?.actions.map((action) => action._tag)).toEqual([
          "link-remove",
          "link-remove",
          "link-create",
        ]);
        expect(plan.units[0]?.actions[2]).toMatchObject({
          _tag: "link-create",
          evidence: { sourceDirectoryPath: newSource },
          relativeTarget: path.relative(skillDirectory, newSource),
        });
      }),
    ),
  );

  planningIt.effect("preserves absolute, drifted, and unrecorded symbolic links", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const home = path.join(root, "home");
        const skillDirectory = path.join(home, ".cursor", "skills");
        const source = path.join(root, "source", "skill");
        const other = path.join(root, "source", "other");
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(other, { recursive: true });
        const absolute = catalogEntry("absolute", source);
        const drifted = catalogEntry("drifted", source);
        const foreign = catalogEntry("foreign", source);
        yield* fileSystem.symlink(source, path.join(skillDirectory, "absolute"));
        yield* fileSystem.symlink(
          path.relative(skillDirectory, other),
          path.join(skillDirectory, "drifted"),
        );
        yield* fileSystem.symlink(
          path.relative(skillDirectory, source),
          path.join(skillDirectory, "foreign"),
        );

        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [absolute, drifted, foreign],
          managedLinks: [
            evidence("cursor", targetUser(home), absolute),
            evidence("cursor", targetUser(home), drifted),
          ],
          namespaces: reconciliationNamespaces(
            [
              namespaceResolution(userNamespace, [
                absolute.address,
                drifted.address,
                foreign.address,
              ]),
            ],
            [targetUser(home)],
          ),
        });

        expect(plan.units[0]?.actions).toEqual([]);
        expect(plan.units[0]?.conflicts.map((conflict) => conflict._tag)).toEqual([
          "managed-link-drift",
          "managed-link-drift",
          "foreign-destination",
        ]);
        expect(
          plan.units[0]?.conflicts.find(
            (conflict) =>
              conflict._tag === "managed-link-drift" &&
              conflict.destinationPath.endsWith("absolute"),
          ),
        ).toMatchObject({ observation: { _tag: "absolute-link", rawTarget: source } });
      }),
    ),
  );

  planningIt.effect("preserves recorded and unrecorded dangling relative links", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const home = path.join(root, "home");
        const skillDirectory = path.join(home, ".cursor", "skills");
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        const recorded = catalogEntry("recorded", path.join(root, "missing", "recorded"));
        const foreign = catalogEntry("foreign", path.join(root, "missing", "foreign"));
        yield* fileSystem.symlink(
          "../../../missing/recorded",
          path.join(skillDirectory, "recorded"),
        );
        yield* fileSystem.symlink("../../../missing/foreign", path.join(skillDirectory, "foreign"));

        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [recorded, foreign],
          managedLinks: [evidence("cursor", targetUser(home), recorded)],
          namespaces: reconciliationNamespaces(
            [namespaceResolution(userNamespace, [recorded.address, foreign.address])],
            [targetUser(home)],
          ),
        });

        expect(plan.units[0]?.actions).toEqual([]);
        expect(plan.units[0]?.conflicts).toMatchObject([
          {
            _tag: "foreign-destination",
            observation: { _tag: "unresolved-relative-link" },
          },
          {
            _tag: "managed-link-drift",
            observation: { _tag: "unresolved-relative-link" },
          },
        ]);
      }),
    ),
  );

  planningIt.effect(
    "releases a recorded link changed outside Tack once its resource is no longer selected",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "tack-plan-test-",
          });
          const root = yield* fileSystem.realPath(temporaryRoot);
          const home = path.join(root, "home");
          const skillDirectory = path.join(home, ".cursor", "skills");
          const elsewhere = path.join(root, "elsewhere");
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.makeDirectory(elsewhere, { recursive: true });
          const entries = Object.fromEntries(
            ["absent", "dangling", "kept", "moved", "owned"].map((name) => [
              name,
              catalogEntry(name, path.join(root, "source", name)),
            ]),
          );
          for (const entry of Object.values(entries)) {
            yield* fileSystem.makeDirectory(entry.directoryPath, { recursive: true });
          }
          const linkTo = (name: string, target: string) =>
            fileSystem.symlink(target, path.join(skillDirectory, name));
          yield* linkTo("dangling", "../../../missing/dangling");
          yield* linkTo("kept", path.relative(skillDirectory, elsewhere));
          yield* linkTo("moved", path.relative(skillDirectory, elsewhere));
          yield* linkTo("owned", path.relative(skillDirectory, entries["owned"]!.directoryPath));

          const plan = yield* planReconciliation({
            adapters: [agentAdapterDescriptor("cursor")],
            catalogEntries: Object.values(entries),
            managedLinks: Object.values(entries).map((entry) =>
              evidence("cursor", targetUser(home), entry),
            ),
            namespaces: reconciliationNamespaces(
              [namespaceResolution(userNamespace, [entries["kept"]!.address])],
              [targetUser(home)],
            ),
          });

          expect(plan.units[0]?.actions).toMatchObject([
            {
              _tag: "evidence-retire",
              evidence: { address: { name: "absent" } },
              reason: "absent",
            },
            {
              _tag: "evidence-retire",
              evidence: { address: { name: "dangling" } },
              reason: "released",
            },
            {
              _tag: "evidence-retire",
              evidence: { address: { name: "moved" } },
              reason: "released",
            },
            { _tag: "link-remove", evidence: { address: { name: "owned" } }, reason: "deselected" },
          ]);
          expect(plan.units[0]?.conflicts).toMatchObject([
            { _tag: "managed-link-drift", evidence: { address: { name: "kept" } } },
          ]);
          expect(plan.units[0]?.summary).toEqual({
            blocked: 0,
            collision: 0,
            conflict: 1,
            create: 0,
            release: 2,
            remove: 1,
            retire: 1,
          });
          expect(Schema.decodeUnknownSync(ReconciliationPlanSchema)(plan)).toEqual(plan);
        }),
      ),
  );

  planningIt.effect("keeps a changed link a drift conflict while its name is a collision", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const home = path.join(root, "home");
        const skillDirectory = path.join(home, ".cursor", "skills");
        const elsewhere = path.join(root, "elsewhere");
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.makeDirectory(elsewhere, { recursive: true });
        const shared = catalogEntry("same", path.join(root, "shared", "same"));
        const owned = catalogEntry("same", path.join(root, "private", "same"), "private");
        yield* fileSystem.symlink(
          path.relative(skillDirectory, elsewhere),
          path.join(skillDirectory, "same"),
        );

        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [shared, owned],
          managedLinks: [evidence("cursor", targetUser(home), shared)],
          namespaces: reconciliationNamespaces(
            [namespaceResolution(userNamespace, [shared.address, owned.address])],
            [targetUser(home)],
          ),
        });

        expect(plan.units[0]?.actions).toEqual([]);
        expect(plan.units[0]?.collisions).toHaveLength(1);
        expect(plan.units[0]?.conflicts).toMatchObject([{ _tag: "managed-link-drift" }]);
      }),
    ),
  );

  planningIt.effect("leaves out of a project what the same adapter links for the user", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-plan-test-" }),
        );
        const project = path.join(root, "project");
        const skillDirectory = path.join(project, ".claude", "skills");
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        const [alpha, beta, lint, review, otherReview] = [
          catalogEntry("alpha", path.join(root, "shared", "alpha")),
          catalogEntry("beta", path.join(root, "shared", "beta")),
          catalogEntry("lint", path.join(root, "shared", "lint")),
          catalogEntry("review", path.join(root, "shared", "review")),
          catalogEntry("review", path.join(root, "private", "review"), "private"),
        ];
        const entries = [alpha, beta, lint, review, otherReview];
        for (const entry of entries)
          yield* fileSystem.makeDirectory(entry.directoryPath, { recursive: true });
        // The project linked beta before the user picked it.
        yield* fileSystem.symlink(
          path.relative(skillDirectory, beta.directoryPath),
          path.join(skillDirectory, "beta"),
        );

        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("claude"), agentAdapterDescriptor("codex")],
          catalogEntries: entries,
          managedLinks: [evidence("claude", targetProject(project), beta)],
          namespaces: reconciliationNamespaces(
            [
              namespaceResolution(
                { _tag: "project", projectName: "project" },
                entries.map((entry) => entry.address),
              ),
            ],
            [targetProject(project)],
          ),
          // Only Claude links them for the user; a review of another source keeps its collision,
          // and the user's lint of another source leaves the project's own lint linked.
          userLinks: [alpha.address, beta.address, review.address, address("lint", "private")].map(
            (linked) => ({ adapter: "claude", address: linked }),
          ),
        });

        const [claude, codex] = plan.units;
        expect(claude?.linkedForUser).toEqual([alpha.address, beta.address]);
        expect(claude?.actions).toMatchObject([
          {
            _tag: "link-remove",
            evidence: { address: { name: "beta" } },
            reason: "linked-for-user",
          },
          { _tag: "link-create", evidence: { address: { name: "lint" } } },
        ]);
        expect(claude?.collisions).toMatchObject([{ name: "review" }]);
        expect(codex).not.toHaveProperty("linkedForUser");
        expect(
          codex?.actions.flatMap((action) =>
            action._tag === "link-create" ? [action.evidence.address.name] : [],
          ),
        ).toEqual(["alpha", "beta", "lint"]);
      }),
    ),
  );

  planningIt.effect.each(["deselected", "removed from its source"] as const)(
    "releases the three adapter links of a skill moved into the repository once it is %s",
    (change) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "tack-plan-test-",
          });
          const root = yield* fileSystem.realPath(temporaryRoot);
          const repository = path.join(root, "repository");
          const target = targetProject(repository, "tack");
          const tackGit = catalogEntry(
            "tack-git",
            path.join(root, "personal-brain", "skills", "tack-git"),
          );
          yield* fileSystem.makeDirectory(tackGit.directoryPath, { recursive: true });
          yield* fileSystem.makeDirectory(path.join(repository, ".ai", "skills", "tack-git"), {
            recursive: true,
          });
          const adapters = ["claude", "codex", "cursor"] as const;
          const links = [".claude", ".agents", ".cursor"].map((directory) =>
            path.join(repository, directory, "skills", "tack-git"),
          );
          for (const link of links) {
            yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
            yield* fileSystem.symlink("../../.ai/skills/tack-git", link);
          }

          const plan = yield* planReconciliation({
            adapters: adapters.map(agentAdapterDescriptor),
            catalogEntries: change === "deselected" ? [tackGit] : [],
            managedLinks: adapters.map((adapter) => evidence(adapter, target, tackGit)),
            namespaces: reconciliationNamespaces(
              [namespaceResolution({ _tag: "project", projectName: "tack" }, [])],
              [target],
            ),
          });

          expect(plan.units.map((unit) => [unit.actions, unit.conflicts])).toEqual(
            links.map((destinationPath, index) => [
              [
                {
                  _tag: "evidence-retire",
                  destinationPath,
                  evidence: evidence(adapters[index]!, target, tackGit),
                  reason: "released",
                },
              ],
              [],
            ]),
          );
        }),
      ),
  );

  planningIt.effect("preserves real file and directory destinations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const home = path.join(root, "home");
        const skillDirectory = path.join(home, ".cursor", "skills");
        const source = path.join(root, "source");
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.writeFileString(path.join(skillDirectory, "file"), "operator-owned");
        yield* fileSystem.makeDirectory(path.join(skillDirectory, "directory"));
        const fileEntry = catalogEntry("file", source);
        const directoryEntry = catalogEntry("directory", source);

        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [fileEntry, directoryEntry],
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [namespaceResolution(userNamespace, [fileEntry.address, directoryEntry.address])],
            [targetUser(home)],
          ),
        });

        expect(plan.units[0]?.actions).toEqual([]);
        expect(plan.units[0]?.conflicts).toMatchObject([
          { _tag: "foreign-destination", observation: { entryType: "directory" } },
          { _tag: "foreign-destination", observation: { entryType: "file" } },
        ]);
        expect(yield* fileSystem.readFileString(path.join(skillDirectory, "file"))).toBe(
          "operator-owned",
        );
      }),
    ),
  );

  planningIt.effect("states which selected kinds each adapter delivers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const home = path.join(root, "home");
        const commandFile = path.join(root, "source", "commands", "ship.md");
        yield* fileSystem.makeDirectory(home, { recursive: true });
        const command = {
          activation: "default",
          address: { kind: "command", name: "ship", sourceRegistrationId: registrationId },
          dependencies: [],
          directoryPath: path.dirname(commandFile),
          filePath: commandFile,
          frontmatter: {},
          projects: [],
          sourcePath: path.join(root, "source"),
          sourceRegistrationId: registrationId,
        } satisfies CatalogEntryOf<"command">;
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("claude"), agentAdapterDescriptor("cursor")],
          catalogEntries: [command],
          managedLinks: [],
          namespaces: [
            {
              namespace: userNamespace,
              resolution: {
                groups: [{ _tag: "selected", members: [command.address] }],
                optionalSkips: [],
                requestBlockers: [],
              },
              targets: [targetUser(home)],
            },
          ],
        });

        expect(plan.units).toMatchObject([
          {
            actions: [],
            adapter: "claude",
            delivery: { command: "unsupported", skill: "delivered" },
          },
          {
            actions: [
              { _tag: "directory-create", directoryPath: path.join(home, ".cursor", "commands") },
              {
                _tag: "link-create",
                destinationPath: path.join(home, ".cursor", "commands", "ship.md"),
              },
            ],
            adapter: "cursor",
            delivery: { command: "delivered", skill: "delivered" },
          },
        ]);
      }),
    ),
  );

  planningIt.effect(
    "blocks a link when the platform cannot derive a non-empty relative target",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "tack-plan-test-",
          });
          const root = yield* fileSystem.realPath(temporaryRoot);
          const home = path.join(root, "home");
          const skillDirectory = path.join(home, ".cursor", "skills");
          const entry = catalogEntry("self", skillDirectory);
          const plan = yield* planReconciliation({
            adapters: [agentAdapterDescriptor("cursor")],
            catalogEntries: [entry],
            managedLinks: [],
            namespaces: reconciliationNamespaces(
              [namespaceResolution(userNamespace, [entry.address])],
              [targetUser(home)],
            ),
          });

          expect(plan.units[0]).toMatchObject({
            actions: [],
            conflicts: [{ _tag: "relative-target-unavailable" }],
          });
        }),
      ),
  );

  planningIt.effect("cleans a verified collision while planning unrelated skills", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const home = path.join(root, "home");
        const skillDirectory = path.join(home, ".cursor", "skills");
        const sharedSource = path.join(root, "source", "shared-same");
        const privateSource = path.join(root, "source", "private-same");
        const healthySource = path.join(root, "source", "healthy");
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.makeDirectory(sharedSource, { recursive: true });
        yield* fileSystem.makeDirectory(privateSource, { recursive: true });
        yield* fileSystem.makeDirectory(healthySource, { recursive: true });
        const shared = catalogEntry("same", sharedSource);
        const privateEntry = catalogEntry("same", privateSource, "private");
        const healthy = catalogEntry("healthy", healthySource);
        yield* fileSystem.symlink(
          path.relative(skillDirectory, sharedSource),
          path.join(skillDirectory, "same"),
        );

        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [privateEntry, healthy, shared],
          managedLinks: [evidence("cursor", targetUser(home), shared)],
          namespaces: reconciliationNamespaces(
            [
              namespaceResolution(userNamespace, [
                shared.address,
                privateEntry.address,
                healthy.address,
              ]),
            ],
            [targetUser(home)],
          ),
        });

        expect(plan.units[0]?.collisions).toEqual([
          { addresses: [shared.address, privateEntry.address], name: "same" },
        ]);
        expect(plan.units[0]?.actions.map((action) => action._tag)).toEqual([
          "link-remove",
          "link-create",
        ]);
        expect(plan.units[0]?.actions[1]).toMatchObject({
          _tag: "link-create",
          evidence: { address: { name: "healthy" } },
        });
      }),
    ),
  );

  planningIt.effect("reports every name collision of a unit in name order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-plan-test-" }),
        );
        const home = path.join(root, "home");
        yield* fileSystem.makeDirectory(path.join(home, ".cursor", "skills"), { recursive: true });
        const entries = (["zeta", "alpha"] as const).flatMap((name) => [
          catalogEntry(name, path.join(root, "shared", name)),
          catalogEntry(name, path.join(root, "private", name), "private"),
        ]);
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: entries,
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [
              namespaceResolution(
                userNamespace,
                entries.map((entry) => entry.address),
              ),
            ],
            [targetUser(home)],
          ),
        });

        expect(plan.units[0]?.collisions.map((collision) => collision.name)).toEqual([
          "alpha",
          "zeta",
        ]);
        expect(plan.units[0]?.actions.filter((action) => action._tag === "link-create")).toEqual(
          [],
        );
      }),
    ),
  );

  planningIt.effect(
    "names an unhealthy source or a quarantine as the reason a link is removed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.realPath(
            yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-plan-test-" }),
          );
          const home = path.join(root, "home");
          const skillDirectory = path.join(home, ".cursor", "skills");
          const unhealthyId = "00000000-0000-4000-8000-000000000002";
          const broken = {
            ...catalogEntry("broken", path.join(root, "source", "broken"), "private"),
            sourceRegistrationId: unhealthyId,
          };
          const dropped = catalogEntry("dropped", path.join(root, "source", "dropped"));
          const faulty = catalogEntry("faulty", path.join(root, "source", "faulty"));
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          for (const entry of [broken, dropped, faulty]) {
            yield* fileSystem.makeDirectory(entry.directoryPath, { recursive: true });
            yield* fileSystem.symlink(
              path.relative(skillDirectory, entry.directoryPath),
              path.join(skillDirectory, entry.address.name),
            );
          }

          const plan = yield* planReconciliation({
            adapters: [agentAdapterDescriptor("cursor")],
            catalogEntries: [dropped],
            managedLinks: [broken, dropped, faulty].map((entry) =>
              evidence("cursor", targetUser(home), entry),
            ),
            namespaces: reconciliationNamespaces(
              [namespaceResolution(userNamespace, [])],
              [targetUser(home)],
            ),
            quarantinedAddresses: [faulty.address],
            unhealthySourceIds: [unhealthyId],
          });

          expect(plan.units[0]?.actions).toMatchObject([
            {
              _tag: "link-remove",
              evidence: { address: { name: "broken" } },
              reason: "source-unhealthy",
            },
            {
              _tag: "link-remove",
              evidence: { address: { name: "dropped" } },
              reason: "deselected",
            },
            {
              _tag: "link-remove",
              evidence: { address: { name: "faulty" } },
              reason: "quarantined",
            },
          ]);
          expect(Schema.decodeUnknownSync(ReconciliationPlanSchema)(plan)).toEqual(plan);
        }),
      ),
  );

  planningIt.effect("names the blocker of a link removed because its dependency is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const home = path.join(root, "home");
        const skillDirectory = path.join(home, ".cursor", "skills");
        const requesterSource = path.join(root, "source", "requester");
        const healthySource = path.join(root, "source", "healthy");
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.makeDirectory(requesterSource, { recursive: true });
        yield* fileSystem.makeDirectory(healthySource, { recursive: true });
        const requester = catalogEntry("requester", requesterSource);
        const healthy = catalogEntry("healthy", healthySource);
        yield* fileSystem.symlink(
          path.relative(skillDirectory, requesterSource),
          path.join(skillDirectory, "requester"),
        );
        const blocker = {
          _tag: "required-missing",
          dependency: { kind: "skill", name: "missing" },
          requester: requester.address,
        } as const;

        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("cursor")],
          catalogEntries: [requester, healthy],
          managedLinks: [evidence("cursor", targetUser(home), requester)],
          namespaces: reconciliationNamespaces(
            [
              {
                namespace: userNamespace,
                resolution: {
                  groups: [
                    { _tag: "blocked", blockers: [blocker], members: [requester.address] },
                    { _tag: "selected", members: [healthy.address] },
                  ],
                  optionalSkips: [],
                  requestBlockers: [],
                },
              },
            ],
            [targetUser(home)],
          ),
        });

        expect(plan.units[0]?.actions).toContainEqual(
          expect.objectContaining({
            _tag: "link-remove",
            blockers: [blocker],
            reason: "blocked",
          }),
        );
        expect(plan.units[0]?.summary).toEqual({
          blocked: 1,
          collision: 0,
          conflict: 0,
          create: 1,
          release: 0,
          remove: 1,
          retire: 0,
        });
        expect(Schema.decodeUnknownSync(ReconciliationPlanSchema)(plan)).toEqual(plan);
      }),
    ),
  );

  planningIt.effect("blocks only the units whose adapter lacks a required capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const source = path.join(root, "source", "alpha");
        yield* fileSystem.makeDirectory(source, { recursive: true });
        const entry = catalogEntry("alpha", source);
        const common = {
          adapters: [agentAdapterDescriptor("claude"), agentAdapterDescriptor("cursor")],
          catalogEntries: [entry],
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [namespaceResolution(userNamespace, [entry.address])],
            [targetUser(path.join(root, "home"))],
          ),
        } as const;

        const unrequired = yield* planReconciliation(common);
        const required = yield* planReconciliation({
          ...common,
          requiredCapability: "command-links",
        });

        expect(unrequired.units.map((unit) => "capability" in unit)).toEqual([false, false]);
        expect(required.units).toMatchObject([
          {
            actions: [],
            adapter: "claude",
            capability: { _tag: "blocked", capability: "command-links" },
            summary: { create: 0 },
          },
          {
            adapter: "cursor",
            capability: { _tag: "supported", capability: "command-links" },
            summary: { create: 1 },
          },
        ]);
      }),
    ),
  );

  planningIt.effect("keeps empty namespaces inert", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const plan = yield* planReconciliation({
          adapters: [agentAdapterDescriptor("codex")],
          catalogEntries: [],
          managedLinks: [],
          namespaces: reconciliationNamespaces(
            [namespaceResolution({ _tag: "project", projectName: "project" }, [])],
            [targetProject(path.join(root, "project")), targetUser(path.join(root, "home"))],
          ),
        });

        expect(plan.units).toMatchObject([{ actions: [], conflicts: [] }]);
      }),
    ),
  );

  planningIt.effect("normalizes permutations and isolates destination observation failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tack-plan-test-",
        });
        const root = yield* fileSystem.realPath(temporaryRoot);
        const home = path.join(root, "home");
        const project = path.join(root, "project");
        const source = path.join(root, "source", "alpha");
        yield* fileSystem.makeDirectory(home, { recursive: true });
        yield* fileSystem.makeDirectory(project, { recursive: true });
        yield* fileSystem.makeDirectory(source, { recursive: true });
        const entry = catalogEntry("alpha", source);
        const resolutions = [
          namespaceResolution(userNamespace, [entry.address]),
          namespaceResolution({ _tag: "project", projectName: "project" }, [entry.address]),
        ];
        const targets = [targetUser(home), targetProject(project)];
        const input = {
          adapters: agentAdapterDescriptors,
          catalogEntries: [entry],
          managedLinks: [],
          namespaces: reconciliationNamespaces(resolutions, targets),
        } as const;
        const cursorDirectory = path.join(home, ".cursor", "skills");
        const platformError = PlatformError.badArgument({ module: "test", method: "readLink" });
        const withFailure = <A, E>(
          effect: Effect.Effect<A, E, Destination | FileSystem.FileSystem | Path.Path>,
        ) =>
          effect.pipe(
            Effect.provideService(
              Destination,
              makeDestinationService(
                {
                  ...fileSystem,
                  readLink: (candidate) =>
                    candidate === cursorDirectory
                      ? Effect.fail(platformError)
                      : fileSystem.readLink(candidate),
                  stat: (candidate) =>
                    candidate === cursorDirectory
                      ? Effect.fail(platformError)
                      : fileSystem.stat(candidate),
                },
                path,
              ),
            ),
            Effect.provideService(FileSystem.FileSystem, {
              ...fileSystem,
              readLink: (candidate) =>
                candidate === cursorDirectory
                  ? Effect.fail(platformError)
                  : fileSystem.readLink(candidate),
              stat: (candidate) =>
                candidate === cursorDirectory
                  ? Effect.fail(platformError)
                  : fileSystem.stat(candidate),
            }),
          );

        const forward = yield* withFailure(planReconciliation(input));
        const reversed = yield* withFailure(
          planReconciliation({
            ...input,
            adapters: [...input.adapters].reverse(),
            catalogEntries: [...input.catalogEntries].reverse(),
            namespaces: reconciliationNamespaces(
              [...resolutions].reverse(),
              [...targets].reverse(),
            ),
          }),
        );

        expect(reversed).toEqual(forward);
        expect(
          forward.units.find(
            (unit) => unit.adapter === "cursor" && unit.target.canonicalPath === home,
          )?.conflicts,
        ).toMatchObject([{ _tag: "destination-directory-conflict" }]);
        // Every user and project unit plans its links except the one whose observation failed.
        expect(forward.units.filter((unit) => unit.actions.length > 0)).toHaveLength(
          agentAdapterDescriptors.length * targets.length - 1,
        );
      }),
    ),
  );
});
