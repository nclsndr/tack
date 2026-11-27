import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import { decodeState, encodeState } from "../../domain/state/state-codec.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { runtimeFixture } from "../../../test/support/state-fixture.ts";
import { docsLink, type DocsManagedLink } from "../../domain/docs/docs-schema.ts";
import type { ProjectRecord } from "../../domain/projects/project-schema.ts";
import { Destination } from "../../services/destination.ts";
import { type DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";
import type { ManagedLinkEvidence } from "../../domain/links/managed-link-schema.ts";
import { planRemoval } from "./removal-plan.ts";
import type { RemovalRequest, RemovalScope } from "../../domain/reconciliation/removal-schema.ts";
import { prepareRemovalState } from "./removal-apply.ts";

const project: ProjectRecord = {
  name: "demo",
  gitCommonDirectory: "/project/.git",
  roots: ["/project", "/second"],
};
const removingProject: ProjectRecord = {
  name: "gone",
  gitCommonDirectory: "/gone/.git",
  roots: [],
  removingRoots: ["/gone"],
  removalIntent: "project",
};
const docs: DocsManagedLink = {
  projectName: "demo",
  root: "/project",
  resource: {
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",

    name: "guide",
  },
  destinationPath: "/project/docs/guide",
  sourceDirectoryPath: "/source/docs/guide",
};
const evidence = (
  name: string,
  target: ManagedLinkEvidence["target"],
  adapter: ManagedLinkEvidence["adapter"] = "codex",
): ManagedLinkEvidence => ({
  adapter,
  address: { kind: "skill", name, sourceRegistrationId: "00000000-0000-4000-8000-000000000001" },
  sourceDirectoryPath: `/source/skills/${name}`,
  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  target,
});
const demoRoot = { _tag: "project-root", canonicalPath: "/project", projectName: "demo" } as const;
const secondRoot = { _tag: "project-root", canonicalPath: "/second", projectName: "demo" } as const;
const goneRoot = { _tag: "project-root", canonicalPath: "/gone", projectName: "gone" } as const;
const user = { _tag: "user", canonicalPath: "/home" } as const;
const owned = evidence("owned", demoRoot);
const foreign = evidence("foreign", demoRoot);
const cursorOwned = evidence("cursor-owned", demoRoot, "cursor");
const absent = evidence("absent", secondRoot);
const userOwned = evidence("user-owned", user);
const pendingOnly = evidence("pending-only", goneRoot);

/** One state holding every evidence shape a removal scope can select. */
const state: State = runtimeFixture({
  version: 1,
  data: {
    docsLinks: [docs],
    enabledAdapters: ["codex", "cursor"],
    agentLinks: [owned, foreign, cursorOwned, absent, userOwned],
    pendingRemovals: [
      {
        cause: "project-removal",
        evidence: pendingOnly,
        lastResult: { _tag: "blocked", message: "Foreign destination." },
      },
    ],
    projects: [project, removingProject],
  },
});

const observations = new Map<string, DestinationObservation>(
  [owned, cursorOwned, userOwned, pendingOnly].map((item) => {
    const destinationPath = managedLinkDestinationPath(item);
    return [
      destinationPath,
      {
        _tag: "relative-link",
        canonicalTarget: item.sourceDirectoryPath,
        destinationPath,
        rawTarget: "../source",
      },
    ];
  }),
);
observations.set(managedLinkDestinationPath(foreign), {
  _tag: "entry",
  destinationPath: managedLinkDestinationPath(foreign),
  entryType: "file",
});
const destinations = Destination.of({
  linkDirectory: (directoryPath) => Effect.succeed(directoryPath),
  observe: (destinationPath) =>
    Effect.succeed(observations.get(destinationPath) ?? { _tag: "absent", destinationPath }),
});

/** The fake filesystem's directories are where they say they are, so docs parents are safe. */
const world = Layer.merge(
  Path.layer,
  FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) }),
);

const requests: ReadonlyArray<readonly [string, RemovalRequest, (state: State) => State]> = [
  [
    "non-final root",
    { scope: { _tag: "project-root", canonicalRoot: "/second", projectName: "demo" } },
    (current) => current,
  ],
  ["whole project", { scope: { _tag: "project", projectName: "demo" } }, (current) => current],
  ["removing project", { scope: { _tag: "project", projectName: "gone" } }, (current) => current],
  ["maintenance", { scope: { _tag: "maintenance" } }, (current) => current],
  [
    "selected targets",
    { cause: "clean", scope: { _tag: "selected-targets", targets: [demoRoot, user] } },
    (current) => current,
  ],
  [
    "retry targets",
    { scope: { _tag: "retry-targets", targets: [goneRoot] } },
    (current) => current,
  ],
  [
    "adapter",
    { cause: "adapter-disable", scope: { _tag: "adapter", adapter: "cursor" } },
    (current) => ({ ...current, data: { ...current.data, enabledAdapters: ["codex"] } }),
  ],
  ["reset", { cause: "reset", scope: { _tag: "reset" } }, (current) => current],
];

for (const [name, request, transition] of requests) {
  it.effect(`plans the same ${name} cleanup before and after its prepare transition`, () =>
    Effect.gen(function* () {
      const plan = yield* planRemoval(state, request);
      const prepared = prepareRemovalState(transition(state), plan);
      const replanned = yield* planRemoval(prepared, {
        cause: plan.cause,
        scope: plan.scope,
      });

      expect(plan.actions.length).toBeGreaterThan(0);
      expect(replanned.actions).toEqual(plan.actions);
      expect(replanned.cause).toBe(plan.cause);
      expect(replanned.finalizeProject).toBe(plan.finalizeProject);
      expect(replanned.scope).toEqual(plan.scope);
    }).pipe(Effect.provideService(Destination, destinations), Effect.provide(world)),
  );
}

const roundTrip = (current: State) =>
  encodeState(current).pipe(Effect.flatMap((encoded) => decodeState(encoded)));

for (const scope of [
  { _tag: "project", projectName: "demo" },
  { _tag: "project-root", projectName: "demo", canonicalRoot: "/project" },
  { _tag: "maintenance" },
  { _tag: "reset" },
] satisfies ReadonlyArray<RemovalScope>) {
  it.effect(`plans the same ${scope._tag} cleanup from persisted equivalent ordering`, () =>
    Effect.gen(function* () {
      const plan = yield* planRemoval(state, { scope });
      const stored = yield* roundTrip(state);

      expect(yield* planRemoval(stored, { scope })).toEqual(plan);
    }).pipe(Effect.provideService(Destination, destinations), Effect.provide(world)),
  );
}

it.effect("orders docs removal evidence by code units, not locale", () =>
  Effect.gen(function* () {
    const link = (name: string): DocsManagedLink => ({
      ...docs,
      resource: { ...docs.resource, name },
      destinationPath: `/project/docs/${name}`,
      sourceDirectoryPath: `/source/docs/${name}`,
    });
    const plan = yield* planRemoval(
      runtimeFixture({ version: 1, data: { docsLinks: [link("a"), link("Z")] } }),
      { cause: "reset", scope: { _tag: "reset" } },
    );
    expect(plan.docsActions?.map((action) => action.evidence.resource.name)).toEqual(["Z", "a"]);
  }).pipe(Effect.provideService(Destination, destinations), Effect.provide(world)),
);

/**
 * The projects that hold the root `/project` of an agent link and a docs mount, in each lifecycle a
 * removal scope reads.
 */
const lifecycles: Readonly<Record<string, ProjectRecord>> = {
  "an active root": project,
  "a handed-off root": { ...project, roots: ["/second"], removingRoots: ["/project"] },
  "a removing project": {
    ...project,
    roots: [],
    removingRoots: ["/project"],
    removalIntent: "project",
  },
  "a root its removing project no longer lists": {
    ...project,
    roots: [],
    removingRoots: ["/second"],
    removalIntent: "project",
  },
};

const linkScopes: ReadonlyArray<RemovalScope> = [
  { _tag: "reset" },
  { _tag: "adapter", adapter: "codex" },
  { _tag: "source", sourceRegistrationId: docs.resource.sourceRegistrationId },
  { _tag: "project", projectName: "demo" },
  { _tag: "project-root", projectName: "demo", canonicalRoot: "/project" },
  { _tag: "selected-targets", targets: [demoRoot] },
  { _tag: "retry-targets", targets: [demoRoot] },
  { _tag: "maintenance" },
];

it.effect("selects an agent link and a docs mount on one root alike, except where stated", () =>
  Effect.gen(function* () {
    // Agent links and docs mounts each have their own scope rules (`targetInRemovalScope` and
    // `docsMountInScope`). This compares them on one root, managed and owed, so a change to one
    // rule that the other does not follow fails here unless it is added to the stated differences.
    const agentLink = evidence("guide", demoRoot);
    const rows = yield* Effect.forEach(
      ["managed", "owed"].flatMap((record) =>
        Object.entries(lifecycles).flatMap(([lifecycle, holder]) =>
          linkScopes.map((scope) => ({ record, lifecycle, holder, scope })),
        ),
      ),
      ({ record, lifecycle, holder, scope }) =>
        planRemoval(
          runtimeFixture({
            data:
              record === "managed"
                ? { agentLinks: [agentLink], docsLinks: [docs], projects: [holder] }
                : {
                    pendingRemovals: [{ cause: "clean", evidence: agentLink }],
                    links: [{ ...docsLink(docs), removal: { cause: "clean" }, pendingOnly: true }],
                    projects: [holder],
                  },
          }),
          { scope },
        ).pipe(
          Effect.map((plan) => ({
            case: `${record} on ${lifecycle}, ${scope._tag}`,
            agent: plan.actions.length > 0,
            docs: (plan.docsActions?.length ?? 0) > 0,
          })),
          // A root the project does not list cannot be named by a root removal.
          Effect.catchTag("RemovalRootNotFoundError", () => Effect.succeed(undefined)),
        ),
    );
    const compared = rows.filter((row) => row !== undefined);

    expect(compared).toHaveLength(rows.length - 2);
    // Only a healthy link on an active root is left alone by both retry and maintenance.
    expect(
      compared.filter((row) => row.agent === false && row.docs === false).map((row) => row.case),
    ).toEqual([
      "managed on an active root, retry-targets",
      "managed on an active root, maintenance",
    ]);
    // A docs mount has no adapter, so an adapter scope never selects one.
    expect(compared.filter((row) => row.case.endsWith(", adapter"))).toEqual(
      compared
        .filter((row) => row.case.endsWith(", adapter"))
        .map((row) => ({ ...row, agent: true, docs: false })),
    );
    expect(
      compared
        .filter((row) => row.agent !== row.docs && row.case.endsWith(", adapter") === false)
        .map((row) => `${row.case}: ${row.agent === true ? "agent link" : "docs mount"} only`),
    ).toEqual([
      // Retry settles what is owed. A managed docs mount on a root that is no longer active counts
      // as owed; a managed agent link there waits for maintenance or a scope that names it.
      "managed on a handed-off root, retry-targets: docs mount only",
      "managed on a removing project, retry-targets: docs mount only",
      "managed on a root its removing project no longer lists, retry-targets: docs mount only",
      // Maintenance removes every agent link of a project without roots; a docs mount only when its
      // own root is handed off.
      "managed on a root its removing project no longer lists, maintenance: agent link only",
    ]);
  }).pipe(Effect.provideService(Destination, destinations), Effect.provide(world)),
);
