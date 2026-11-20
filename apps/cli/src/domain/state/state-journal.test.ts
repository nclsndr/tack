import { expect, it } from "@effect/vitest";
import { docsLink } from "../docs/docs-schema.ts";
import { agentLink } from "../links/link-record-schema.ts";
import { journalOf, withJournal, withPreparedEntries } from "./state-journal.ts";
import { emptyState, type JournalEntry } from "./state-schema.ts";

const source = "21380456-fa78-4ed4-95ae-110da2a6d41c";

const agent: JournalEntry = {
  _tag: "create",
  link: agentLink({
    adapter: "codex",
    address: { kind: "skill", name: "guide", sourceRegistrationId: source },
    sourceDirectoryPath: "/sources/guide",
    sourceRegistrationId: source,
    target: { _tag: "project-root", projectName: "demo", canonicalPath: "/work/demo" },
  }),
};

const docs: JournalEntry = {
  _tag: "remove",
  link: docsLink({
    projectName: "demo",
    root: "/work/demo",
    resource: { sourceRegistrationId: source, name: "guide" },
    destinationPath: "/work/demo/.tack/docs/guide",
    sourceDirectoryPath: "/sources/docs/guide",
  }),
};

it("holds the entries of both delivery kinds in one journal, in the order they were prepared", () => {
  const prepared = withPreparedEntries(withPreparedEntries(emptyState(), [agent]), [docs]);
  expect(journalOf(prepared)).toEqual([agent, docs]);
  expect(journalOf(emptyState())).toEqual([]);
});

it("replaces the whole journal, drops an empty one and leaves a journal-less state as it is", () => {
  const prepared = withPreparedEntries(emptyState(), [agent, docs]);
  expect(journalOf(withJournal(prepared, [docs]))).toEqual([docs]);

  const settled = withJournal(prepared, []);
  expect(settled.data).not.toHaveProperty("journal");
  expect(settled).toEqual(emptyState());

  const untouched = emptyState();
  expect(withJournal(untouched, [])).toBe(untouched);
  expect(withPreparedEntries(untouched, [])).toBe(untouched);
});
