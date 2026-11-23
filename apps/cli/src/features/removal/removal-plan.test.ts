import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import { decodeState, encodeState } from "../../domain/state/state-codec.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { runtimeFixture } from "../../../test/support/state-fixture.ts";
import type { DocsManagedLink } from "../../domain/docs/docs-schema.ts";
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
