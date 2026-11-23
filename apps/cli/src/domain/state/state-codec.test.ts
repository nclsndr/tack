import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runtimeFixture } from "../../../test/support/state-fixture.ts";
import { docsLink } from "../docs/docs-schema.ts";
import { agentLink } from "../links/link-record-schema.ts";
import type { ManagedLinkEvidence } from "../links/managed-link-schema.ts";
import { decodeState, encodeState } from "./state-codec.ts";
import { emptyState, type State } from "./state-schema.ts";

const source = "21380456-fa78-4ed4-95ae-110da2a6d41c";
const other = "7d3f1c2a-9b4e-4f6a-8c1d-2e5b6a7c8d9e";

const evidence = (name: string, overrides: Partial<ManagedLinkEvidence> = {}) =>
  ({
    adapter: "codex",
    address: { kind: "skill", name, sourceRegistrationId: source },
    sourceDirectoryPath: `/sources/skills/${name}`,
    sourceRegistrationId: source,
    target: { _tag: "project-root", projectName: "demo", canonicalPath: "/work/demo" },
    ...overrides,
  }) satisfies ManagedLinkEvidence;

const mount = (name: string) => ({
  projectName: "demo",
  root: "/work/demo",
  resource: { sourceRegistrationId: source, name },
  destinationPath: `/work/demo/.tack/docs/${source}/${name}`,
  sourceDirectoryPath: `/sources/docs/${name}`,
});

const failsDecoding = (document: unknown) =>
  Effect.map(Effect.result(decodeState(document)), (result) => result._tag === "Failure");

const failsEncoding = (state: State) =>
  Effect.map(Effect.result(encodeState(state)), (result) => result._tag === "Failure");

const withData = (data: Partial<State["data"]>): State => ({
  ...emptyState(),
  data: { ...emptyState().data, ...data },
});

it.effect("writes format as the first field of the document", () =>
  Effect.gen(function* () {
    const document = yield* encodeState(emptyState());
    expect(Object.keys(document)).toEqual(["format", "data"]);
    expect(document).toEqual({
      format: 1,
      data: { enabledAdapters: [], sources: [], projects: [], userChoices: [], links: [] },
    });
    expect(yield* decodeState(JSON.parse(JSON.stringify(document)))).toEqual(emptyState());
  }),
);

it.effect("keeps a fixed profile application and a bundle-provided source in format 1", () =>
  Effect.gen(function* () {
    const address = { kind: "skill", name: "review", sourceRegistrationId: source } as const;
    const state = withData({
      sources: [
        {
          id: source,
          canonicalPath: "/sources/a",
          bundle: {
            identity: "a".repeat(64),
            sourceKey: "shared",
            bindings: {},
            sourceKeys: {},
            files: [],
          },
        },
      ],
      profileApplications: [
        {
          namespace: { _tag: "user" },
          profileName: "ci",
          sourceRegistrationId: source,
          direct: [address],
          inventory: [address],
          targets: ["/home/ci"],
        },
      ],
    });
    const document = yield* encodeState(state);
    expect(document.format).toBe(1);
    expect(yield* decodeState(JSON.parse(JSON.stringify(document)))).toEqual(state);
  }),
);

it.effect("orders every collection canonically whatever order it arrives in", () =>
  Effect.gen(function* () {
    const state = runtimeFixture({
      data: {
        enabledAdapters: ["claude", "cursor"],
        sources: [
          { id: other, canonicalPath: "/sources/b" },
          { id: source, canonicalPath: "/sources/a" },
        ],
        projects: [
          { name: "zeta", gitCommonDirectory: "/z/.git", roots: ["/z/a", "/z/b"] },
          { name: "alpha", gitCommonDirectory: "/a/.git", roots: ["/a"] },
        ],
        agentLinks: [evidence("zed"), evidence("able")],
        docsLinks: [mount("guide")],
      },
    });
    const document = yield* encodeState(state);
    expect(document.data.enabledAdapters).toEqual(["claude", "cursor"]);
    expect(document.data.sources.map((entry) => entry.id)).toEqual([source, other]);
    expect(document.data.projects.map((project) => project.name)).toEqual(["alpha", "zeta"]);
    expect(document.data.links.map((record) => record.destinationPath)).toEqual([
      "/work/demo/.agents/skills/able",
      "/work/demo/.agents/skills/zed",
      `/work/demo/.tack/docs/${source}/guide`,
    ]);
    expect(yield* encodeState(yield* decodeState(JSON.parse(JSON.stringify(document))))).toEqual(
      document,
    );
  }),
);

it.effect("refuses a resource identity without a source in any collection", () =>
  Effect.gen(function* () {
    const unpinned = { kind: "skill", name: "writing" };
    const document = JSON.parse(JSON.stringify(emptyState()));
    expect(
      yield* failsDecoding({
        ...document,
        data: { ...document.data, userChoices: [{ address: unpinned, decision: "include" }] },
      }),
    ).toBe(true);
    expect(
      yield* failsDecoding({
        ...document,
        data: {
          ...document.data,
          projects: [
            {
              name: "demo",
              gitCommonDirectory: "/work/demo/.git",
              roots: ["/work/demo"],
              removingRoots: [],
              choices: [{ address: unpinned, decision: "include" }],
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      yield* failsDecoding({
        ...document,
        data: {
          ...document.data,
          links: [{ ...agentLink(evidence("writing")), resource: unpinned }],
        },
      }),
    ).toBe(true);
    expect(
      yield* failsDecoding({
        ...document,
        data: {
          ...document.data,
          projects: [
            {
              name: "demo",
              gitCommonDirectory: "/work/demo/.git",
              roots: ["/work/demo"],
              removingRoots: [],
              docs: { attachments: [{ name: "guide" }] },
            },
          ],
        },
      }),
    ).toBe(true);
  }),
);

it.effect("refuses fields of earlier layouts and any other excess field", () =>
  Effect.gen(function* () {
    const document = JSON.parse(JSON.stringify(emptyState()));
    for (const extra of [
      { docsManagedLinks: [] },
      { docsJournal: { action: "create" } },
      { reconciliationJournal: { action: { _tag: "directory-create", directoryPath: "/x" } } },
      { unknown: true },
    ])
      expect(yield* failsDecoding({ ...document, data: { ...document.data, ...extra } })).toBe(
        true,
      );
    expect(yield* failsDecoding({ ...document, version: 4 })).toBe(true);
    expect(yield* failsDecoding({ ...document, extra: true })).toBe(true);
  }),
);

it.effect("keeps one ledger record per destination across both delivery kinds", () =>
  Effect.gen(function* () {
    const agent = agentLink(evidence("guide"));
    // A docs mount that claims the destination of an agent link.
    const claiming = {
      ...docsLink({ ...mount("guide"), destinationPath: agent.destinationPath }),
    };
    expect(yield* failsEncoding(withData({ links: [agent, claiming] }))).toBe(true);
    expect(yield* failsEncoding(withData({ links: [agent, agentLink(evidence("other"))] }))).toBe(
      false,
    );
  }),
);

it.effect("holds a journal that is a list with each destination at most once", () =>
  Effect.gen(function* () {
    const first = agentLink(evidence("first"));
    const second = agentLink(evidence("second"));
    const state = withData({
      journal: [
        { _tag: "create", link: first },
        { _tag: "remove", link: docsLink(mount("guide")) },
      ],
    });
    const decoded = yield* decodeState(JSON.parse(JSON.stringify(yield* encodeState(state))));
    expect(decoded.data.journal?.map((entry) => entry._tag)).toEqual(["create", "remove"]);
    expect(
      yield* failsEncoding(
        withData({
          journal: [
            { _tag: "create", link: first },
            { _tag: "remove", link: first },
          ],
        }),
      ),
    ).toBe(true);
    // An empty journal is not written: nothing prepared means no journal.
    expect(yield* failsEncoding(withData({ journal: [] }))).toBe(true);
    // Directory creation is never journaled.
    expect(
      yield* failsDecoding({
        ...JSON.parse(JSON.stringify(emptyState())),
        data: {
          ...JSON.parse(JSON.stringify(emptyState().data)),
          journal: [{ _tag: "directory-create", directoryPath: "/work/demo/.codex" }],
        },
      }),
    ).toBe(true);
    expect(
      (yield* encodeState(withData({ journal: [{ _tag: "create", link: second }] }))).data.journal,
    ).toHaveLength(1);
  }),
);

it.effect("agrees prepared entries with retained ownership or exact replacement evidence", () =>
  Effect.gen(function* () {
    const retained = agentLink(evidence("writing"));
    const next = agentLink(evidence("writing", { sourceDirectoryPath: "/sources/next/writing" }));
    // The same evidence may be prepared again, as a create or as a remove.
    expect(
      yield* failsEncoding(
        withData({ links: [retained], journal: [{ _tag: "create", link: retained }] }),
      ),
    ).toBe(false);
    expect(
      yield* failsEncoding(
        withData({ links: [retained], journal: [{ _tag: "remove", link: retained }] }),
      ),
    ).toBe(false);
    // Different evidence for a retained destination is refused unless it names that evidence as replaced.
    expect(
      yield* failsEncoding(
        withData({ links: [retained], journal: [{ _tag: "create", link: next }] }),
      ),
    ).toBe(true);
    expect(
      yield* failsEncoding(
        withData({ links: [retained], journal: [{ _tag: "remove", link: next }] }),
      ),
    ).toBe(true);
    expect(
      yield* failsEncoding(
        withData({
          links: [retained],
          journal: [{ _tag: "replace", link: next, previous: retained }],
        }),
      ),
    ).toBe(false);
    expect(
      yield* failsEncoding(
        withData({
          links: [retained],
          journal: [
            {
              _tag: "replace",
              link: next,
              previous: agentLink(evidence("writing", { adapter: "claude" })),
            },
          ],
        }),
      ),
    ).toBe(true);
    // A record that owes a removal cannot be replaced.
    expect(
      yield* failsEncoding(
        withData({
          links: [{ ...retained, removal: { cause: "reset" } }],
          journal: [{ _tag: "replace", link: next, previous: retained }],
        }),
      ),
    ).toBe(true);
    // A destination with no record may be prepared freely.
    expect(yield* failsEncoding(withData({ journal: [{ _tag: "create", link: next }] }))).toBe(
      false,
    );
  }),
);

it.effect("refuses a state that its own schema rejects instead of writing it", () =>
  Effect.gen(function* () {
    const state = withData({
      projects: [
        { name: "one", gitCommonDirectory: "/r/.git", roots: ["/r"], removingRoots: [] },
        { name: "two", gitCommonDirectory: "/r/.git", roots: ["/r"], removingRoots: [] },
      ],
    });
    expect(yield* failsEncoding(state)).toBe(true);
    expect(yield* failsEncoding(Object.assign(emptyState(), { format: 3 }))).toBe(true);
  }),
);
