import { writeUnder, bareSkillText, tackMetadata } from "../../../test/support/source-tree.ts";
import { managedLinksOf } from "../../domain/links/link-record-schema.ts";
import { mutateStateFixture, stateOptionsAt } from "../../../test/support/state-fixture.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { SecureRandom } from "effect/crypto";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { initializeState, type StateOptions } from "../../services/state-store.ts";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import type { Selector } from "../../domain/projects/project-schema.ts";
import { enableAdapters } from "../reconciliation/agent.ts";
import { syncResources } from "../../../test/support/reconciliation.ts";
import { makeSourceService, registerSource, Source } from "../sources/source.ts";
import { compareCodeUnits, sortAndDedupeBy } from "../../domain/identity/ordering.ts";
import { resourceAddressIdentity } from "../../domain/sources/catalog-schema.ts";
import { runStatus, statusPartialCauses } from "./status.ts";
import {
  generatedSkillRegistrationId,
  userSourcesSkillName,
} from "../../domain/generated/sources-skill.ts";

/**
 * A source with a default skill that optionally depends on an opt-in skill, a default command, a
 * skill only projects select, and one registered project, so selections differ by namespace and by
 * optional closure.
 */
const agreementFixture = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-status-agreement-" }),
  );
  const home = path.join(root, "home");
  const source = path.join(root, "source");
  const workspace = path.join(root, "workspace");
  const anchor = path.join(root, "anchor");
  const options: StateOptions = stateOptionsAt(path.join(root, "state"), home);
  const write = writeUnder(source);
  yield* Effect.forEach([home, workspace, anchor], (directory) =>
    fileSystem.makeDirectory(directory, { recursive: true }),
  );
  yield* write("tack.yaml", "version: 1\nname: source\nskills:\n  - path: skills\n");
  yield* write(
    "skills/lead/SKILL.md",
    bareSkillText("lead", {
      description: "Lead",
      tack: [
        "user-activation: default",
        "dependencies:",
        "  - kind: skill",
        "    name: extra",
        "    optional: true",
      ],
    }),
  );
  yield* write(
    "skills/extra/SKILL.md",
    bareSkillText("extra", { description: "Extra", tack: ["activation: opt-in"] }),
  );
  // Only projects select it; a project leaves the others to the user's links.
  yield* write("skills/local/SKILL.md", bareSkillText("local", { description: "Local" }));
  yield* write(
    "commands/review.md",
    `---\n${tackMetadata("user-activation: default")}---\nReview\n`,
  );
  yield* initializeState(options);
  yield* registerSource(options, { sourcePath: source });
  yield* enableAdapters(options, ["claude", "codex", "cursor"]);
  yield* mutateStateFixture(options, (state) => ({
    ...state,
    data: {
      ...state.data,
      projects: [{ gitCommonDirectory: anchor, name: "workspace", roots: [workspace] }],
    },
  }));

  /** Applies or previews reconciliation and reads status with the same options. */
  const reconcile = (request: {
    readonly apply: boolean;
    readonly cwd?: string;
    readonly includeOptional: boolean;
    readonly selector: Selector;
  }) =>
    syncResources(options, {
      apply: request.apply,
      cwd: request.cwd ?? root,
      includeOptional: request.includeOptional,
      selector: request.selector,
    });
  const status = (request: {
    readonly cwd?: string;
    readonly includeOptional: boolean;
    readonly selector: Selector;
  }) =>
    runStatus(options, {
      cwd: request.cwd ?? root,
      includeOptional: request.includeOptional,
      selector: request.selector,
    });
  return { fileSystem, home, options, path, reconcile, root, source, status, workspace };
});

const nonMatching = (report: {
  readonly destinations: ReadonlyArray<{ readonly _tag: string; readonly destinationPath: string }>;
}) =>
  report.destinations
    .filter((destination) => destination._tag !== "matching")
    .map((destination) => [destination._tag, destination.destinationPath]);

it.layer(LiveTestLayer)("status agrees with the reconciliation planner", (agreementIt) => {
  for (const [name, selector, includeOptional, cwdInWorkspace] of [
    ["the user target", { _tag: "user" }, false, false],
    ["the user target with optional dependencies", { _tag: "user" }, true, false],
    ["a project", { _tag: "project", projectName: "workspace" }, false, false],
    [
      "a project with optional dependencies",
      { _tag: "project", projectName: "workspace" },
      true,
      false,
    ],
    ["a bare selector with optional dependencies", { _tag: "bare" }, true, true],
  ] as const) {
    agreementIt.effect(`reports only matching destinations after applying ${name}`, () =>
      Effect.gen(function* () {
        const f = yield* agreementFixture();
        const request = {
          ...(cwdInWorkspace ? { cwd: f.workspace } : {}),
          includeOptional,
          selector,
        };

        const applied = yield* f.reconcile({ ...request, apply: true });
        const report = yield* f.status(request);

        expect(applied.partial).toBe(false);
        expect(report.destinations.length).toBeGreaterThan(0);
        expect(nonMatching(report)).toEqual([]);
        expect(statusPartialCauses(report)).toHaveLength(0);
        const replanned = yield* f.reconcile({ ...request, apply: false });
        expect(replanned.plan.units.flatMap((unit) => unit.actions)).toEqual([]);
      }),
    );
  }

  agreementIt.effect(
    "tags optional links that a plain reconcile would remove the way the planner decides",
    () =>
      Effect.gen(function* () {
        const f = yield* agreementFixture();
        yield* f.reconcile({ apply: true, includeOptional: true, selector: { _tag: "user" } });

        const plain = yield* f.reconcile({
          apply: false,
          includeOptional: false,
          selector: { _tag: "user" },
        });
        const plainStatus = yield* f.status({ includeOptional: false, selector: { _tag: "user" } });
        const withOptional = yield* f.status({ includeOptional: true, selector: { _tag: "user" } });

        const removed = plain.plan.units
          .flatMap((unit) => unit.actions)
          .filter((action) => action._tag === "link-remove");
        expect(removed.map((action) => action.reason)).toEqual(
          removed.map(() => "deselected" as const),
        );
        expect(removed.length).toBeGreaterThan(0);
        expect(
          plainStatus.destinations
            .filter((destination) => destination._tag !== "matching")
            .map((destination) => destination.destinationPath)
            .sort(),
        ).toEqual(removed.map((action) => action.destinationPath).sort());
        expect(nonMatching(withOptional)).toEqual([]);
        expect(statusPartialCauses(withOptional)).toHaveLength(0);
      }),
  );

  agreementIt.effect(
    "does not make status partial for an exclude choice whose resource is absent",
    () =>
      Effect.gen(function* () {
        const f = yield* agreementFixture();
        yield* mutateStateFixture(f.options, (state) => ({
          ...state,
          data: {
            ...state.data,
            userChoices: [
              {
                address: {
                  kind: "skill" as const,
                  name: "retired",
                  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
                },
                decision: "exclude" as const,
              },
            ],
          },
        }));

        const applied = yield* f.reconcile({
          apply: true,
          includeOptional: false,
          selector: { _tag: "user" },
        });
        const report = yield* f.status({ includeOptional: false, selector: { _tag: "user" } });

        expect(applied.partial).toBe(false);
        expect(report.namespaces[0]?.selection.unresolvedChoices).toHaveLength(1);
        expect(statusPartialCauses(report)).toHaveLength(0);
      }),
  );

  agreementIt.effect(
    "tags the changed links of a deselected skill as the releases the planner decides",
    () =>
      Effect.gen(function* () {
        const f = yield* agreementFixture();
        const user = { includeOptional: false, selector: { _tag: "user" } } as const;
        yield* f.reconcile({ ...user, apply: true });
        const lead = (yield* f.status(user)).destinations.filter(
          (destination) => destination.evidence?.address.name === "lead",
        );
        const moved = f.path.join(f.root, "moved", "lead");
        yield* f.fileSystem.makeDirectory(moved, { recursive: true });
        for (const { destinationPath } of lead) {
          yield* f.fileSystem.remove(destinationPath);
          yield* f.fileSystem.symlink(
            f.path.relative(f.path.dirname(destinationPath), moved),
            destinationPath,
          );
        }
        yield* mutateStateFixture(f.options, (state) => {
          const leadAddress = managedLinksOf(state.data.links).find(
            (evidence) => evidence.address.name === "lead",
          )?.address;
          if (leadAddress === undefined) throw new Error("Expected lead evidence.");
          return {
            ...state,
            data: { ...state.data, userChoices: [{ address: leadAddress, decision: "exclude" }] },
          };
        });

        const preview = yield* f.reconcile({ ...user, apply: false });
        const report = yield* f.status(user);

        const released = preview.plan.units
          .flatMap((unit) => unit.actions)
          .filter((action) => action._tag === "evidence-retire");
        expect(released.map((action) => action.reason)).toEqual(lead.map(() => "released"));
        expect(lead.length).toBe(3);
        expect(preview.partial).toBe(false);
        const byPath = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
          compareCodeUnits(left[1] ?? "", right[1] ?? "");
        // With lead excluded the user links nothing of the source, so its sources skill goes too.
        const removed = preview.plan.units
          .flatMap((unit) => unit.actions)
          .filter((action) => action._tag === "link-remove");
        expect(removed.map((action) => [action.evidence.address.name, action.reason])).toEqual(
          lead.map(() => [userSourcesSkillName, "deselected"]),
        );
        expect(nonMatching(report).sort(byPath)).toEqual(
          [
            ...released.map((action) => ["evidence-changed", action.destinationPath]),
            ...removed.map((action) => ["drift", action.destinationPath]),
          ].sort(byPath),
        );
        expect(statusPartialCauses(report).length).toBeGreaterThan(0);

        yield* f.reconcile({ ...user, apply: true });
        const settled = yield* f.status(user);
        expect(nonMatching(settled)).toEqual([]);
        expect(statusPartialCauses(settled)).toHaveLength(0);
        for (const { destinationPath } of lead) {
          expect(yield* f.fileSystem.realPath(destinationPath)).toBe(moved);
        }
      }),
  );

  agreementIt.effect("does not report evidence for a different user target than reconcile", () =>
    Effect.gen(function* () {
      const f = yield* agreementFixture();
      yield* f.reconcile({ apply: true, includeOptional: false, selector: { _tag: "user" } });
      const oldHome = f.path.join(f.root, "old-home");
      const oldEvidence = {
        adapter: "codex" as const,
        address: { kind: "skill" as const, name: "lead" },
        sourceDirectoryPath: f.path.join(f.source, "skills", "lead"),
        sourceRegistrationId: "",
        target: { _tag: "user" as const, canonicalPath: oldHome },
      };
      const oldDestination = managedLinkDestinationPath(oldEvidence);
      yield* f.fileSystem.makeDirectory(f.path.dirname(oldDestination), { recursive: true });
      yield* f.fileSystem.symlink(
        f.path.relative(f.path.dirname(oldDestination), oldEvidence.sourceDirectoryPath),
        oldDestination,
      );
      yield* mutateStateFixture(f.options, (state) => {
        const current = managedLinksOf(state.data.links);
        const registrationId = current[0]?.sourceRegistrationId ?? "";
        return {
          ...state,
          data: {
            ...state.data,
            agentLinks: [
              ...current,
              {
                ...oldEvidence,
                address: { ...oldEvidence.address, sourceRegistrationId: registrationId },
                sourceRegistrationId: registrationId,
              },
            ],
          },
        };
      });

      const replanned = yield* f.reconcile({
        apply: false,
        includeOptional: false,
        selector: { _tag: "user" },
      });
      const report = yield* f.status({ includeOptional: false, selector: { _tag: "user" } });

      expect(replanned.partial).toBe(false);
      expect(replanned.plan.units.flatMap((unit) => [...unit.actions, ...unit.conflicts])).toEqual(
        [],
      );
      expect(report.destinations.map((destination) => destination.destinationPath)).not.toContain(
        oldDestination,
      );
      expect(nonMatching(report)).toEqual([]);
      expect(statusPartialCauses(report)).toHaveLength(0);
    }),
  );

  agreementIt.effect(
    "plans no destinations under a stale project root, which sync never targets",
    () =>
      Effect.gen(function* () {
        const f = yield* agreementFixture();
        const project = {
          includeOptional: false,
          selector: { _tag: "project", projectName: "workspace" },
        } as const;
        const stale = f.path.join(f.root, "stale");
        yield* mutateStateFixture(f.options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: state.data.projects.map((entry) => ({
              ...entry,
              roots: [f.workspace, stale].sort(compareCodeUnits),
            })),
          },
        }));

        const applied = yield* f.reconcile({ ...project, apply: true });
        const replanned = yield* f.reconcile({ ...project, apply: false });
        const report = yield* f.status(project);

        expect(
          [...applied.plan.units, ...replanned.plan.units].map((unit) => unit.target.canonicalPath),
        ).not.toContain(stale);
        expect(replanned.plan.units.flatMap((unit) => unit.actions)).toEqual([]);
        expect(report.destinations.length).toBeGreaterThan(0);
        expect(
          report.destinations.map((destination) => destination.target.canonicalPath),
        ).not.toContain(stale);
        expect(nonMatching(report)).toEqual([]);
        expect(
          report.projects.flatMap((entry) => entry.roots).find((root) => root.path === stale)
            ?.health,
        ).toBe("missing");
      }),
  );

  agreementIt.effect("leaves built-in links under a fixed user profile alone, as sync does", () =>
    Effect.gen(function* () {
      const f = yield* agreementFixture();
      const builtins = f.path.join(f.root, "builtins");
      const writeBuiltin = writeUnder(builtins);
      yield* writeBuiltin("tack.yaml", "version: 1\nname: tack\nskills:\n  - path: skills\n");
      yield* writeBuiltin(
        "skills/helper/SKILL.md",
        bareSkillText("helper", { description: "Helper", tack: ["user-activation: default"] }),
      );
      const source = makeSourceService(yield* SecureRandom.SecureRandom, f.fileSystem, f.path, [
        { canonicalPath: builtins, id: "00000000-0000-4000-8000-0000000000b1" },
      ]);
      const user = { includeOptional: false, selector: { _tag: "user" } } as const;

      yield* Effect.gen(function* () {
        yield* f.reconcile({ ...user, apply: true });
        const helper = (yield* f.status(user)).destinations
          .filter((destination) => destination.evidence?.address.name === "helper")
          .map((destination) => destination.destinationPath);
        yield* mutateStateFixture(f.options, (state) => {
          const addresses = sortAndDedupeBy(
            managedLinksOf(state.data.links)
              .map((evidence) => evidence.address)
              // A profile names resources of sources, never the sources skill Tack generates.
              .filter(
                (address) =>
                  address.name !== "helper" &&
                  address.sourceRegistrationId !== generatedSkillRegistrationId,
              ),
            resourceAddressIdentity,
          );
          const registered = addresses[0]?.sourceRegistrationId;
          if (registered === undefined) throw new Error("Expected registered evidence.");
          return {
            ...state,
            data: {
              ...state.data,
              profileApplications: [
                {
                  direct: addresses,
                  inventory: addresses,
                  namespace: { _tag: "user" },
                  profileName: "fixed",
                  sourceRegistrationId: registered,
                  targets: [f.home],
                },
              ],
            },
          };
        });

        const preview = yield* f.reconcile({ ...user, apply: false });
        const report = yield* f.status(user);

        expect(preview.partial).toBe(false);
        expect(preview.plan.units.flatMap((unit) => [...unit.actions, ...unit.conflicts])).toEqual(
          [],
        );
        expect(helper).toHaveLength(3);
        expect(report.destinations.length).toBeGreaterThan(0);
        expect(
          report.destinations.filter((destination) => helper.includes(destination.destinationPath)),
        ).toEqual([]);
        expect(nonMatching(report)).toEqual([]);
      }).pipe(Effect.provideService(Source, source));
    }),
  );
});
