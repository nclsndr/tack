import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DocsManagedLink } from "../docs/docs-schema.ts";
import type { ManagedLinkEvidence } from "../links/managed-link-schema.ts";
import { managedLinkDestinationPath } from "../agents/agent-layout.ts";
import type { State } from "./state-schema.ts";
import { runtimeFixture, type FixtureData } from "../../../test/support/state-fixture.ts";
import {
  decodeState as decodePersistedState,
  encodeState as encodePersistedState,
} from "./state-codec.ts";

type Data = FixtureData;

const sourceA = "21380456-fa78-4ed4-95ae-110da2a6d41c";
const sourceB = "7d3f1c2a-9b4e-4f6a-8c1d-2e5b6a7c8d9e";
const alphaRoot = "/work/alpha";
const omegaRoot = "/work/omega";
const home = "/home/me";

const link = (name: string, overrides: Partial<ManagedLinkEvidence> = {}): ManagedLinkEvidence => ({
  adapter: "codex",
  address: { kind: "skill", name, sourceRegistrationId: sourceA },
  sourceRegistrationId: sourceA,
  sourceDirectoryPath: `/sources/a/skills/${name}`,
  target: { _tag: "project-root", projectName: "alpha", canonicalPath: alphaRoot },
  ...overrides,
});

const pending = (
  evidence: ManagedLinkEvidence,
  cause: NonNullable<Data["pendingRemovals"]>[number]["cause"],
  lastResult?: NonNullable<Data["pendingRemovals"]>[number]["lastResult"],
) => ({
  cause,
  evidence,
  ...(lastResult === undefined ? {} : { lastResult }),
});

const docsLink = (name: string, root = alphaRoot, projectName = "alpha"): DocsManagedLink => {
  const destinationPath = `${root}/.tack/docs/${sourceB}/shared/${name}`;
  const sourceDirectoryPath = `/sources/b/docs/${name}`;
  return {
    projectName,
    root,
    resource: { sourceRegistrationId: sourceB, name },
    destinationPath,
    sourceDirectoryPath,
  };
};

const handbook = { sourceRegistrationId: sourceB, name: "handbook" };
const guide = { sourceRegistrationId: sourceB, name: "guide" };

const projects: NonNullable<Data["projects"]> = [
  {
    name: "alpha",
    gitCommonDirectory: `${alphaRoot}/.git`,
    roots: [alphaRoot, `${alphaRoot}-wt`],
    removingRoots: [`${alphaRoot}-old`],
  },
  {
    name: "omega",
    gitCommonDirectory: `${omegaRoot}/.git`,
    roots: [],
    removingRoots: [omegaRoot],
    removalIntent: "project",
  },
  {
    name: "zeta",
    gitCommonDirectory: "/work/zeta/.git",
    roots: [],
    removingRoots: ["/work/zeta"],
  },
];

const registrations: Data = {
  enabledAdapters: ["claude", "codex", "cursor"],
  sources: [
    { id: sourceA, canonicalPath: "/sources/a" },
    { id: sourceB, canonicalPath: "/sources/b" },
  ],
};

const choices: Data = {
  projects,
  choices: [
    {
      address: { kind: "skill", name: "tone", sourceRegistrationId: sourceA },
      decision: "include",
      namespace: { _tag: "user" },
    },
    {
      address: { kind: "command", name: "review", sourceRegistrationId: sourceA },
      decision: "exclude",
      namespace: { _tag: "project", projectName: "alpha" },
    },
    {
      address: { kind: "skill", name: "writing", sourceRegistrationId: sourceA },
      decision: "include",
      namespace: { _tag: "project", projectName: "alpha" },
    },
    {
      address: { kind: "skill", name: "writing", sourceRegistrationId: sourceA },
      decision: "exclude",
      namespace: { _tag: "project", projectName: "omega" },
    },
  ],
};

const docsSettings: Data = {
  projects,
  docsProjects: [
    {
      projectName: "alpha",
      attachments: [guide, handbook],
      destination: "manual/docs",
      defaultWritingResource: handbook,
    },
    { projectName: "omega", attachments: [handbook] },
  ],
};

const userLink = link("tone", {
  adapter: "claude",
  target: { _tag: "user", canonicalPath: home },
});
const commandLink = link("review", {
  adapter: "cursor",
  address: { kind: "command", name: "review", sourceRegistrationId: sourceA },
  sourceDirectoryPath: "/sources/a/commands/review.md",
  target: { _tag: "user", canonicalPath: home },
});
const windowsLink = link("tone", {
  target: { _tag: "user", canonicalPath: "C:/Users/ada" },
});
const retiring = link("retiring");
const orphan = link("orphan", {
  target: { _tag: "project-root", projectName: "omega", canonicalPath: omegaRoot },
});

const agentLinks: Data = {
  agentLinks: [retiring, link("writing"), userLink, commandLink, windowsLink],
  pendingRemovals: [
    pending(windowsLink, "reset"),
    pending(retiring, "adapter-disable", { _tag: "blocked", message: "Keep this reason." }),
    pending(orphan, "project-removal", { _tag: "interrupted", message: "Stopped." }),
  ].sort((left, right) =>
    managedLinkDestinationPath(left.evidence) < managedLinkDestinationPath(right.evidence) ? -1 : 1,
  ),
};

const replacement = { ...link("writing"), sourceDirectoryPath: "/sources/a/next/writing" };
const linkJournal: Data = {
  agentLinks: [link("writing")],
  preparedAgentAction: {
    action: {
      _tag: "link-create",
      evidence: replacement,
      previousEvidence: link("writing"),
      destinationPath: managedLinkDestinationPath(replacement),
      relativeTarget: `./${posix.relative(
        posix.dirname(managedLinkDestinationPath(replacement)),
        replacement.sourceDirectoryPath,
      )}`,
    },
  },
};

const docsLinks: Data = {
  projects,
  docsLinks: [docsLink("guide"), docsLink("handbook")],
  preparedDocsAction: { action: "remove", evidence: docsLink("handbook", omegaRoot, "omega") },
};

const recovery: Data = {
  pendingRemovals: [pending(orphan, "reset", { _tag: "filesystem-failure", message: "EACCES" })],
  preparedDocsAction: { action: "create", evidence: docsLink("guide") },
};

const removalMatrix: Data = {
  pendingRemovals: [
    pending(link("clean"), "clean"),
    pending(link("root-removal"), "root-removal", { _tag: "blocked", message: "Retained." }),
    pending(link("project-removal"), "project-removal", {
      _tag: "interrupted",
      message: "Stopped.",
    }),
    pending(link("adapter-disable"), "adapter-disable"),
    pending(link("reset"), "reset", { _tag: "filesystem-failure", message: "EACCES" }),
  ].sort((left, right) =>
    managedLinkDestinationPath(left.evidence) < managedLinkDestinationPath(right.evidence) ? -1 : 1,
  ),
};

const linkRemoveJournal: Data = {
  agentLinks: [link("writing")],
  preparedAgentAction: {
    action: {
      _tag: "link-remove",
      destinationPath: managedLinkDestinationPath(link("writing")),
      evidence: link("writing"),
      reason: "cleanup",
    },
  },
};

const realSized: Data = {
  ...registrations,
  agentLinks: Array.from({ length: 1_274 }, (_, index) =>
    link(`skill-${String(index % 39).padStart(2, "0")}`, {
      target: {
        _tag: "project-root",
        projectName: "alpha",
        canonicalPath: `/work/root-${String(Math.floor(index / 39)).padStart(2, "0")}`,
      },
    }),
  ).sort((left, right) =>
    managedLinkDestinationPath(left).localeCompare(managedLinkDestinationPath(right)),
  ),
};

const fixtureNames = [
  "empty",
  "registrations",
  "choices",
  "docsSettings",
  "agentLinks",
  "linkJournal",
  "docsLinks",
  "recovery",
  "full",
  "removalMatrix",
  "linkRemoveJournal",
  "realSized",
] as const;

/** One representative runtime state per persisted section, plus one combining every section. */
const fixtures: Record<(typeof fixtureNames)[number], Data> = {
  empty: {},
  registrations,
  choices,
  docsSettings,
  agentLinks,
  linkJournal,
  docsLinks,
  recovery,
  removalMatrix,
  linkRemoveJournal,
  realSized,
  full: {
    ...registrations,
    ...choices,
    ...docsSettings,
    ...linkJournal,
    ...agentLinks,
    ...docsLinks,
  },
};

const fixture = (name: (typeof fixtureNames)[number]): State =>
  runtimeFixture({ format: 1, data: fixtures[name] });

/** A deterministic shuffle: orders values by a seeded linear-congruential key. */
const shuffle = <A>(values: ReadonlyArray<A>, seed: number): A[] =>
  values
    .map((value, index) => ({
      key: (Math.imul((seed ^ (index * 2_654_435_761)) >>> 0, 1_103_515_245) + 12_345) >>> 0,
      value,
    }))
    .sort((left, right) => left.key - right.key)
    .map(({ value }) => value);

/** Reorders every runtime collection whose order carries no meaning. */
const permute = (state: State, seed: number): State => {
  const data = state.data;
  return {
    format: state.format,
    data: {
      ...data,
      sources: shuffle(data.sources, seed),
      projects: shuffle(data.projects, seed + 1).map((project) => ({
        ...project,
        ...(project.choices === undefined ? {} : { choices: shuffle(project.choices, seed + 2) }),
        ...(project.docs === undefined
          ? {}
          : {
              docs: {
                ...project.docs,
                attachments: shuffle(project.docs.attachments, seed + 5),
              },
            }),
      })),
      userChoices: shuffle(data.userChoices, seed + 2),
      links: shuffle(data.links, seed + 3),
    },
  };
};

/** The bytes the state store writes for one document. */
const fileText = (document: unknown) => JSON.stringify(document, null, 2);
const goldenDirectory = fileURLToPath(new URL("./fixtures/format-1/", import.meta.url));
/** The real-sized fixture is covered by the round trip only: its bytes would be a 400 KB file. */
const goldenNames = fixtureNames.filter((name) => name !== "realSized");

it.effect("pins the format 1 bytes of every fixture and their hash list", () =>
  Effect.gen(function* () {
    const hashes: string[] = [];
    for (const name of goldenNames) {
      const fileName = `${name}.state`;
      const filePath = `${goldenDirectory}${fileName}`;
      const bytes = fileText(yield* encodePersistedState(fixture(name)));
      if (process.env["TACK_UPDATE_GOLDEN"] === "1") {
        mkdirSync(goldenDirectory, { recursive: true });
        writeFileSync(filePath, bytes);
      }
      const golden = readFileSync(filePath, "utf8");
      expect(golden, name).toBe(bytes);
      expect(Object.keys(JSON.parse(golden))).toEqual(["format", "data"]);
      expect(yield* decodePersistedState(JSON.parse(golden))).toEqual(fixture(name));
      hashes.push(`${createHash("sha256").update(golden).digest("hex")}  ${fileName}`);
    }
    const list = `${hashes.join("\n")}\n`;
    const hashPath = `${goldenDirectory}SHA256SUMS`;
    if (process.env["TACK_UPDATE_GOLDEN"] === "1") writeFileSync(hashPath, list);
    expect(readFileSync(hashPath, "utf8")).toBe(list);
  }),
);

it.effect("keeps every fixture canonical: decode(encode(state)) is the same state", () =>
  Effect.gen(function* () {
    for (const name of fixtureNames) {
      const state = fixture(name);
      const decoded = yield* decodePersistedState(yield* encodePersistedState(state));
      expect(decoded, name).toEqual(state);
    }
  }),
);

it.effect("keeps format 1 bytes when runtime docs property order changes", () =>
  Effect.gen(function* () {
    const state = fixture("docsSettings");
    const reordered: State = {
      ...state,
      data: {
        ...state.data,
        projects: (state.data.projects ?? []).map((project) =>
          project.docs === undefined
            ? project
            : {
                ...project,
                docs: {
                  ...(project.docs.destination === undefined
                    ? {}
                    : { destination: project.docs.destination }),
                  attachments: project.docs.attachments,
                },
              },
        ),
      },
    };
    expect(fileText(yield* encodePersistedState(reordered))).toBe(
      fileText(yield* encodePersistedState(state)),
    );
  }),
);

it.effect.prop(
  "round-trips the fixture matrix through state-file bytes under any collection order",
  { name: Schema.Literals(fixtureNames), seed: Schema.Int },
  ({ name, seed }) =>
    Effect.gen(function* () {
      const state = fixture(name);
      const file = fileText(yield* encodePersistedState(state));

      // decode(encode(x)) == x, whatever order the runtime collections arrive in.
      const reordered = permute(state, seed);
      expect(fileText(yield* encodePersistedState(reordered))).toBe(file);
      expect(yield* decodePersistedState(yield* encodePersistedState(reordered))).toEqual(state);

      // encode(decode(file)) == file: rewriting a state file never changes its bytes.
      const decoded = yield* decodePersistedState(JSON.parse(file));
      expect(decoded).toEqual(state);
      expect(fileText(yield* encodePersistedState(decoded))).toBe(file);
    }),
  { arbitrary: { runs: 200 } },
);

it.effect("pins the on-disk document of the combined fixture", () =>
  Effect.gen(function* () {
    const document = yield* encodePersistedState(fixture("full"));
    expect(Object.keys(document)).toEqual(["format", "data"]);
    expect(Object.keys(document.data)).toEqual([
      "enabledAdapters",
      "sources",
      "projects",
      "userChoices",
      "links",
      "journal",
    ]);
    expect(document.data.projects?.map((project) => Object.keys(project))).toEqual([
      ["name", "gitCommonDirectory", "roots", "removingRoots", "choices", "docs"],
      ["name", "gitCommonDirectory", "roots", "removingRoots", "removalIntent", "choices", "docs"],
      ["name", "gitCommonDirectory", "roots", "removingRoots"],
    ]);
    expect(document.data.projects?.[0]?.docs).toEqual({
      attachments: [guide, { ...handbook, writingDefault: true }],
      destination: "manual/docs",
    });
    // Agent links and docs mounts share one ledger, ordered by destination.
    expect(document.data.links).toHaveLength(8);
    const mount = document.data.links.find((record) => record.delivery._tag === "docs");
    expect(mount).toEqual({
      destinationPath: `${alphaRoot}/.tack/docs/${sourceB}/shared/guide`,
      sourceDirectoryPath: "/sources/b/docs/guide",
      resource: { kind: "docs", ...guide },
      target: { _tag: "project-root", projectName: "alpha", canonicalPath: alphaRoot },
      delivery: { _tag: "docs" },
    });
    // The agent journal entry and the docs journal entry live in the one list.
    expect(document.data.journal?.map((entry) => entry._tag)).toEqual(["replace", "remove"]);
  }),
);
