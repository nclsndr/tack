import { expect, it } from "@effect/vitest";
import { agentLink, type LinkChange } from "../../domain/links/link-record-schema.ts";
import type { ManagedLinkEvidence } from "../../domain/links/managed-link-schema.ts";
import { docsLink } from "../../domain/docs/docs-schema.ts";
import type { JournalEntry } from "../../domain/state/state-schema.ts";
import type { DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";
import { settlementChange, settlementOf, type Settlement } from "./link-settlement.ts";

const source = "21380456-fa78-4ed4-95ae-110da2a6d41c";

const evidence = (name: string, sourceDirectoryPath = `/sources/${name}`): ManagedLinkEvidence => ({
  adapter: "codex",
  address: { kind: "skill", name, sourceRegistrationId: source },
  sourceDirectoryPath,
  sourceRegistrationId: source,
  target: { _tag: "project-root", projectName: "demo", canonicalPath: "/work/demo" },
});

const created = evidence("guide");
const destinationPath = agentLink(created).destinationPath;

const entries = {
  create: { _tag: "create", link: agentLink(created) },
  replace: {
    _tag: "replace",
    link: agentLink(created),
    previous: agentLink(evidence("guide", "/sources/old-guide")),
  },
  remove: { _tag: "remove", link: agentLink(created) },
} satisfies Record<string, JournalEntry>;

const observations = {
  absent: { _tag: "absent", destinationPath },
  "the recorded source": {
    _tag: "relative-link",
    canonicalTarget: created.sourceDirectoryPath,
    destinationPath,
    rawTarget: "../../../sources/guide",
  },
  "another source": {
    _tag: "relative-link",
    canonicalTarget: "/sources/old-guide",
    destinationPath,
    rawTarget: "../../../sources/old-guide",
  },
  "a dangling link": {
    _tag: "unresolved-relative-link",
    destinationPath,
    message: "The link target does not exist.",
    rawTarget: "../../../sources/guide",
  },
  "an absolute link": { _tag: "absolute-link", destinationPath, rawTarget: "/sources/guide" },
  "a directory": { _tag: "entry", destinationPath, entryType: "directory" },
  "an unreadable destination": {
    _tag: "access-failed",
    destinationPath,
    message: "Permission denied.",
    operation: "stat",
  },
} satisfies Record<string, DestinationObservation>;

type Row = readonly [keyof typeof entries, keyof typeof observations, Settlement];

/** Every entry kind against every observation: what recovery and an apply's settle decide. */
const decisions: ReadonlyArray<Row> = [
  ["create", "absent", "keep"],
  ["create", "the recorded source", "record"],
  ["create", "another source", "keep"],
  ["create", "a dangling link", "keep"],
  ["create", "an absolute link", "keep"],
  ["create", "a directory", "keep"],
  ["create", "an unreadable destination", "keep"],
  ["replace", "absent", "retire"],
  ["replace", "the recorded source", "record"],
  ["replace", "another source", "keep"],
  ["replace", "a dangling link", "keep"],
  ["replace", "an absolute link", "keep"],
  ["replace", "a directory", "keep"],
  ["replace", "an unreadable destination", "keep"],
  ["remove", "absent", "retire"],
  ["remove", "the recorded source", "keep"],
  ["remove", "another source", "keep"],
  ["remove", "a dangling link", "keep"],
  ["remove", "an absolute link", "keep"],
  ["remove", "a directory", "keep"],
  ["remove", "an unreadable destination", "keep"],
];

it("decides every entry kind by what its destination shows", () => {
  for (const [kind, observed, settlement] of decisions) {
    expect(
      `${kind} + ${observed}: ${settlementOf(entries[kind], observations[observed])}`,
      `${kind} + ${observed}`,
    ).toBe(`${kind} + ${observed}: ${settlement}`);
  }
  expect(decisions).toHaveLength(Object.keys(entries).length * Object.keys(observations).length);
});

/** The same entries for a docs mount, with the observations that mount's proof reads. */
const mount = docsLink({
  projectName: "demo",
  root: "/work/demo",
  resource: { sourceRegistrationId: source, name: "guide" },
  destinationPath: "/work/demo/.tack/docs/guide",
  sourceDirectoryPath: "/sources/docs/guide",
});
const mountText = "../../../../sources/docs/guide";
const mountEntries = {
  create: { _tag: "create", link: mount },
  replace: {
    _tag: "replace",
    link: mount,
    previous: docsLink({
      projectName: "demo",
      root: "/work/demo",
      resource: { sourceRegistrationId: source, name: "guide" },
      destinationPath: "/work/demo/.tack/docs/guide",
      sourceDirectoryPath: "/sources/docs/old-guide",
    }),
  },
  remove: { _tag: "remove", link: mount },
} satisfies Record<string, JournalEntry>;
const mountDestination = mount.destinationPath;
const mountObservations = {
  absent: { _tag: "absent", destinationPath: mountDestination },
  "the recorded source": {
    _tag: "relative-link",
    canonicalTarget: mount.sourceDirectoryPath,
    destinationPath: mountDestination,
    rawTarget: mountText,
  },
  "another source": {
    _tag: "relative-link",
    canonicalTarget: "/sources/docs/old-guide",
    destinationPath: mountDestination,
    rawTarget: "../../../../sources/docs/old-guide",
  },
  "a dangling link": {
    _tag: "unresolved-relative-link",
    destinationPath: mountDestination,
    message: "The link target does not exist.",
    rawTarget: mountText,
  },
  "an absolute link": {
    _tag: "absolute-link",
    destinationPath: mountDestination,
    rawTarget: "/sources/docs/guide",
  },
  "a directory": { _tag: "entry", destinationPath: mountDestination, entryType: "directory" },
  "an unreadable destination": {
    _tag: "access-failed",
    destinationPath: mountDestination,
    message: "Permission denied.",
    operation: "stat",
  },
} satisfies Record<string, DestinationObservation>;

it("decides every docs entry kind by what its destination shows, with the docs proof", () => {
  // The docs proof accepts a dangling link with the derived text, as recovery of a created mount
  // whose source vanished must; the agent proof records only a link that resolves.
  const docsDecisions: ReadonlyArray<Row> = decisions.map(([kind, observed, settlement]) =>
    observed === "a dangling link" && kind !== "remove"
      ? [kind, observed, "record"]
      : [kind, observed, settlement],
  );
  for (const [kind, observed, settlement] of docsDecisions) {
    expect(
      `${kind} + ${observed}: ${settlementOf(mountEntries[kind], mountObservations[observed])}`,
      `${kind} + ${observed}`,
    ).toBe(`${kind} + ${observed}: ${settlement}`);
  }
});

it("turns a settlement into the ledger change it stands for", () => {
  const changes = (entry: JournalEntry, settlement: Settlement): LinkChange | undefined =>
    settlementChange(entry, settlement);

  // A recorded link is managed; the replaced evidence is dropped by the same record.
  expect(changes(entries.create, "record")).toEqual({ _tag: "manage", link: entries.create.link });
  expect(changes(entries.replace, "record")).toEqual({
    _tag: "manage",
    link: entries.replace.link,
  });
  // A retired removal ends the managed link it names; a retired replacement ends the old one.
  expect(changes(entries.remove, "retire")).toEqual({
    _tag: "unmanage",
    link: entries.remove.link,
  });
  expect(changes(entries.replace, "retire")).toEqual({
    _tag: "unmanage",
    link: entries.replace.previous,
  });
  // A create that settled as retired never had a record, so there is nothing to end.
  expect(changes(entries.create, "retire")).toEqual({
    _tag: "unmanage",
    link: entries.create.link,
  });
  for (const entry of Object.values(entries)) {
    expect(changes(entry, "keep")).toBeUndefined();
  }
});
