import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  LinkRecordsSchema,
  LinkRecordSchema,
  agentLink,
  applyLinkChanges,
  linkEvidenceEqual,
  managedAgentEvidence,
  managedLinksOf,
  onlyOwedRemovals,
  pendingRemovalsOf,
  type LinkChange,
  type LinkEvidence,
  type LinkRecord,
} from "./link-record-schema.ts";
import { docsLink, managedDocsEvidence, managedDocsLinksOf } from "../docs/docs-schema.ts";
import type { ManagedLinkEvidence } from "./managed-link-schema.ts";
import {
  PendingRemovalCauseSchema,
  strongerPendingRemovalCause,
  type PendingRemovalCause,
  type PendingRemovalLastResult,
} from "./pending-removal-schema.ts";

const source = "21380456-fa78-4ed4-95ae-110da2a6d41c";

const evidence = (
  name: string,
  overrides: Partial<ManagedLinkEvidence> = {},
): ManagedLinkEvidence => ({
  adapter: "codex",
  address: { kind: "skill", name, sourceRegistrationId: source },
  sourceDirectoryPath: `/sources/skills/${name}`,
  sourceRegistrationId: source,
  target: { _tag: "project-root", projectName: "demo", canonicalPath: "/work/demo" },
  ...overrides,
});

/** The flat link the ledger holds for one agent evidence. */
const link = (name: string, overrides: Partial<ManagedLinkEvidence> = {}): LinkEvidence =>
  agentLink(evidence(name, overrides));

const blocked = { _tag: "blocked" as const, message: "Foreign destination." };
const interrupted = { _tag: "interrupted" as const, message: "Cleanup was interrupted." };

const causeRank: Record<PendingRemovalCause, number> = {
  clean: 0,
  reset: 1,
  "adapter-disable": 2,
  "root-removal": 3,
  "project-removal": 4,
};

const manage = (item: LinkEvidence): LinkChange => ({ _tag: "manage", link: item });
const unmanage = (item: LinkEvidence): LinkChange => ({ _tag: "unmanage", link: item });
const owe = (item: LinkEvidence, cause: PendingRemovalCause): LinkChange => ({
  _tag: "owe",
  link: item,
  cause,
});
const recordResult = (item: LinkEvidence, lastResult: PendingRemovalLastResult): LinkChange => ({
  _tag: "result",
  link: item,
  lastResult,
});
const settle = (item: LinkEvidence): LinkChange => ({ _tag: "settle", link: item });

/** Applies the changes in order, the way every production caller does. */
const applyAll = (records: ReadonlyArray<LinkRecord>, ...changes: ReadonlyArray<LinkChange>) =>
  applyLinkChanges(records, changes);

const recordOf = (records: ReadonlyArray<LinkRecord>, item: LinkEvidence) =>
  records.find((record) => record.resource.name === item.resource.name);

it("holds the three rows of the table as one record per destination", () => {
  const owned = link("owned");
  const owing = link("owing");
  const retiring = link("retiring");
  const records = applyAll(
    [],
    manage(owned),
    manage(owing),
    manage(retiring),
    owe(owing, "root-removal"),
  );
  const noLongerManaged = applyAll(records, owe(retiring, "project-removal"), unmanage(retiring));

  expect(recordOf(noLongerManaged, owned)).toEqual(owned);
  expect(recordOf(noLongerManaged, owing)).toEqual({
    ...owing,
    removal: { cause: "root-removal" },
  });
  expect(recordOf(noLongerManaged, retiring)).toEqual({
    ...retiring,
    removal: { cause: "project-removal" },
    pendingOnly: true,
  });
  expect(managedLinksOf(noLongerManaged)).toEqual([evidence("owned"), evidence("owing")]);
  expect(pendingRemovalsOf(noLongerManaged)).toEqual([
    { cause: "root-removal", evidence: evidence("owing") },
    { cause: "project-removal", evidence: evidence("retiring") },
  ]);
  expect(Schema.is(LinkRecordsSchema)(noLongerManaged)).toBe(true);
});

it("moves a destination between rows the way managed and pending lists did", () => {
  const item = link("moving");
  const managedOnly = applyAll([], manage(item));

  // Managed, nothing owed: retiring it leaves no record, because neither status remains.
  expect(applyAll(managedOnly, unmanage(item))).toEqual([]);

  // Managed and owing: retiring the managed link leaves the removal pending-only.
  const owing = applyAll(managedOnly, recordResult(item, blocked));
  expect(owing).toEqual([{ ...item, removal: { cause: "clean", lastResult: blocked } }]);
  const pendingOnly = applyAll(owing, unmanage(item));
  expect(pendingOnly).toEqual([
    { ...item, removal: { cause: "clean", lastResult: blocked }, pendingOnly: true },
  ]);

  // Retiring again, or an unknown destination, changes nothing.
  expect(applyAll(pendingOnly, unmanage(item))).toEqual(pendingOnly);
  expect(applyAll(pendingOnly, unmanage(link("other")))).toEqual(pendingOnly);

  // The same proof recorded again makes it managed again with its removal intact.
  expect(applyAll(pendingOnly, manage(item))).toEqual(owing);

  // Settling deletes the record from any row.
  expect(applyAll(owing, settle(item))).toEqual([]);
  expect(applyAll(pendingOnly, settle(item))).toEqual([]);
  expect(applyAll(managedOnly, settle(item))).toEqual([]);

  // A pending removal for a destination with no record is pending-only.
  expect(applyAll([], owe(item, "reset"))).toEqual([
    { ...item, removal: { cause: "reset" }, pendingOnly: true },
  ]);
});

it("replaces evidence that owes nothing and refuses to replace evidence that owes a removal", () => {
  const previous = link("moving");
  const replacement = link("moving", { sourceDirectoryPath: "/sources/other/moving" });

  expect(applyAll([], manage(previous), manage(replacement))).toEqual([replacement]);

  const owing = applyAll([], manage(previous), owe(previous, "root-removal"));
  expect(() => applyAll(owing, manage(replacement))).toThrow("cannot take different evidence");
  expect(() => applyAll(owing, owe(replacement, "project-removal"))).toThrow(
    "cannot take different evidence",
  );
  expect(() => applyAll(owing, recordResult(replacement, blocked))).toThrow(
    "cannot take different evidence",
  );
  const pendingOnly = applyAll(owing, unmanage(previous));
  expect(() => applyAll(pendingOnly, manage(replacement))).toThrow(
    "cannot take different evidence",
  );
  // The refused inputs were not modified.
  expect(owing).toEqual([{ ...previous, removal: { cause: "root-removal" } }]);
});

it("keeps one record per physical destination, including Windows spellings", () => {
  const user = (canonicalPath: string) =>
    link("guide", { target: { _tag: "user", canonicalPath } });
  const decode = Schema.decodeUnknownSync(LinkRecordsSchema);

  expect(() => decode([user("/home/me"), user("/home/me")])).toThrow(
    "unique physical destinations",
  );
  expect(() => decode([user("/home/me"), user("/home/other")])).not.toThrow();
  expect(() => decode([{ ...link("a"), pendingOnly: true }])).toThrow(
    "require a removal obligation",
  );
});

it("keeps one record per destination across both delivery kinds", () => {
  const mount = docsLink({
    projectName: "demo",
    root: "/work/demo",
    resource: { sourceRegistrationId: source, name: "guide" },
    destinationPath: "/work/demo/.claude/skills/guide",
    sourceDirectoryPath: "/sources/docs/guide",
  });
  const agent = link("guide", { adapter: "claude" });
  expect(agent.destinationPath).toBe(mount.destinationPath);
  expect(() => Schema.decodeUnknownSync(LinkRecordsSchema)([agent, mount])).toThrow(
    "unique physical destinations",
  );
});

it("converts a docs mount to a ledger record and back", () => {
  const mount = {
    projectName: "demo",
    root: "/work/demo",
    resource: { sourceRegistrationId: source, name: "guide" },
    destinationPath: "/work/demo/.tack/docs/guide",
    sourceDirectoryPath: "/sources/docs/guide",
  };
  const stored = docsLink(mount);
  expect(stored.delivery).toEqual({ _tag: "docs" });
  expect(Schema.is(LinkRecordSchema)(stored)).toBe(true);
  expect(managedDocsEvidence(stored)).toEqual(mount);
  expect(managedAgentEvidence(stored)).toBeUndefined();
  expect(managedDocsLinksOf([stored, link("a")])).toEqual([mount]);
  expect(managedLinksOf([stored, link("a")])).toEqual([evidence("a")]);
  expect(managedDocsEvidence(link("a"))).toBeUndefined();
  expect(linkEvidenceEqual(stored, docsLink(mount))).toBe(true);
  expect(linkEvidenceEqual(stored, link("a"))).toBe(false);
});

it("refuses a record whose delivery does not fit its resource", () => {
  const decode = Schema.decodeUnknownEffect(LinkRecordSchema);
  const agent = link("a");
  const cases = [
    // An agent link must sit where its adapter places the resource.
    { ...agent, destinationPath: "/work/demo/elsewhere/a" },
    // A docs delivery must deliver a docs resource, to a project root, inside that root.
    { ...agent, delivery: { _tag: "docs" } },
    {
      ...docsLink({
        projectName: "demo",
        root: "/work/demo",
        resource: { sourceRegistrationId: source, name: "guide" },
        destinationPath: "/work/demo/.tack/docs/guide",
        sourceDirectoryPath: "/sources/docs/guide",
      }),
      destinationPath: "/elsewhere/guide",
    },
    // An agent delivery cannot deliver docs.
    {
      ...agent,
      resource: { kind: "docs", name: "guide", sourceRegistrationId: source },
    },
  ];
  for (const candidate of cases) {
    const result = Effect.runSync(Effect.result(decode(candidate)));
    expect(result._tag).toBe("Failure");
  }
});

it("reset keeps only owed removals, all pending-only", () => {
  const owned = link("owned");
  const owing = link("owing");
  const records = applyAll([], manage(owned), manage(owing), owe(owing, "reset"));

  expect(onlyOwedRemovals(records)).toEqual([
    { ...owing, removal: { cause: "reset" }, pendingOnly: true },
  ]);
});

const names = ["a", "b", "c"] as const;
const Operation = Schema.Struct({
  kind: Schema.Literals(["seed", "block", "interrupt", "retire", "manage", "settle"]),
  cause: PendingRemovalCauseSchema,
  name: Schema.Literals(names),
});

it.effect.prop(
  "never lowers a cause or loses a removal when seeding, merging, blocking and retiring",
  { operations: Schema.Array(Operation) },
  ({ operations }) =>
    Effect.sync(() => {
      let records: ReadonlyArray<LinkRecord> = names.map((name) => link(name));
      for (const { kind, cause, name } of operations) {
        const item = link(name);
        const before = recordOf(records, item);
        records = applyAll(
          records,
          kind === "seed"
            ? owe(item, cause)
            : kind === "block"
              ? recordResult(item, blocked)
              : kind === "interrupt"
                ? recordResult(item, interrupted)
                : kind === "retire"
                  ? unmanage(item)
                  : kind === "manage"
                    ? manage(item)
                    : settle(item),
        );
        const after = recordOf(records, item);

        expect(Schema.is(LinkRecordsSchema)(records)).toBe(true);
        expect(records.filter((record) => record.resource.name === name).length).toBe(
          after === undefined ? 0 : 1,
        );
        if (kind === "settle") {
          expect(after).toBeUndefined();
          continue;
        }
        if (before?.removal !== undefined) {
          // A removal is never weakened, dropped or settled except by settling the record.
          expect(after?.removal).toBeDefined();
          expect(causeRank[after?.removal?.cause ?? "clean"]).toBeGreaterThanOrEqual(
            causeRank[before.removal.cause],
          );
        }
        if (kind === "seed" && before?.removal !== undefined) {
          expect(after?.removal?.cause).toBe(
            strongerPendingRemovalCause(before.removal.cause, cause),
          );
          // Merging a cause keeps the last result.
          expect(after?.removal?.lastResult).toEqual(before.removal.lastResult);
        }
        if (kind === "block" || kind === "interrupt") {
          // A recorded result never changes the cause, and makes the removal exist.
          expect(after?.removal?.lastResult?._tag).toBe(
            kind === "block" ? "blocked" : "interrupted",
          );
          expect(after?.removal?.cause).toBe(before?.removal?.cause ?? "clean");
        }
        if (before !== undefined && (kind === "seed" || kind === "block" || kind === "interrupt")) {
          // Owing a removal never changes whether Tack manages the link.
          expect(after?.pendingOnly).toBe(before?.pendingOnly);
        }
      }
    }),
  { arbitrary: { runs: 300 } },
);

const applyOne = (records: ReadonlyArray<LinkRecord>, change: LinkChange): LinkRecord[] =>
  applyLinkChanges(records, [change]);

it.effect.prop(
  "applies a list of changes exactly as the same changes applied one at a time",
  {
    operations: Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["manage", "unmanage", "owe", "result", "settle"]),
        cause: PendingRemovalCauseSchema,
        name: Schema.Literals(names),
      }),
    ),
  },
  ({ operations }) =>
    Effect.sync(() => {
      const changes = operations.map(({ kind, cause, name }): LinkChange => {
        const item = link(name);
        return kind === "owe"
          ? { _tag: "owe", link: item, cause }
          : kind === "result"
            ? { _tag: "result", link: item, lastResult: blocked }
            : { _tag: kind, link: item };
      });
      const start = [link("a"), link("b")];
      // A removal that is owed refuses different evidence, and refuses it the same way in both.
      const attempt = (apply: () => ReadonlyArray<LinkRecord>) => {
        try {
          return { records: apply() };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      };
      expect(attempt(() => applyLinkChanges(start, changes))).toEqual(
        attempt(() => changes.reduce<ReadonlyArray<LinkRecord>>(applyOne, start)),
      );
    }),
  { arbitrary: { runs: 300 } },
);

it("settles a long ledger in one pass, keeping the order records were first written in", () => {
  const count = 40_000;
  const items = Array.from({ length: count }, (_, index) => link(`skill-${index}`));
  const ledger = applyLinkChanges(
    [],
    items.map((item): LinkChange => ({ _tag: "manage", link: item })),
  );
  expect(ledger).toEqual(items);

  const retired = items.filter((_, index) => index % 2 === 0);
  const settled = applyLinkChanges(
    ledger,
    retired.map((item): LinkChange => ({ _tag: "settle", link: item })),
  );
  expect(settled).toEqual(items.filter((_, index) => index % 2 === 1));

  // A removed destination that is recorded again goes to the end, as removing then appending did.
  const second = link("skill-1");
  const again = applyLinkChanges(settled.slice(0, 2), [
    { _tag: "settle", link: second },
    { _tag: "manage", link: second },
  ]);
  expect(again.map((record) => record.resource.name)).toEqual(["skill-3", "skill-1"]);
});

it("refuses a docs link that does not belong to a project root", () => {
  const mount = docsLink({
    projectName: "demo",
    root: "/work/demo",
    resource: { sourceRegistrationId: source, name: "guide" },
    destinationPath: "/work/demo/.tack/docs/guide",
    sourceDirectoryPath: "/sources/docs/guide",
  });

  expect(() =>
    Schema.decodeUnknownSync(LinkRecordSchema)({
      ...mount,
      target: { _tag: "user", canonicalPath: "/home/me" },
    }),
  ).toThrow("A docs link must belong to a project root.");
});
