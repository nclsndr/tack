import { expect, it } from "vitest";
import {
  initialExplorerState,
  pendingChanges,
  selectedRow,
  stepExplorer,
  withAppliedEntries,
  withReview,
  type ExplorerState,
} from "../src/cli/host/human/explorer/model.ts";
import {
  docs,
  editing,
  frame,
  frameLines,
  key,
  locked,
  member,
  nestedFolders,
  on,
  press,
  profile,
  project,
  unavailable,
  user,
} from "./support/explorer.ts";

/** The `00_effect` folder of a choice session over the nested folders. */
const initial = (label = "00_effect"): ExplorerState => on(editing(nestedFolders, user), label);

it.each(["example", "skills", "00_effect"])(
  "stages the entire %s folder even when folded or filtered",
  (label) => {
    const state = initial(label);
    const row = selectedRow(state);
    if (row?.kind !== "folder") throw new Error("Missing folder");
    const folded = press(state, "return");
    expect(pendingChanges(press(folded, "i"))).toHaveLength(label === "00_effect" ? 2 : 3);
    const filtered = on({ ...state, query: "alpha" }, label);
    expect(pendingChanges(press(filtered, "i"))).toEqual(pendingChanges(press(folded, "i")));
  },
);

it("keeps folder staging through review and toggles it off with the same key", () => {
  const staged = press(on(press(on(initial(), "nested"), "i"), "00_effect"), "x");
  const reviewed = withReview(staged, { phase: "preview", title: "Review", lines: ["per child"] });
  expect(stepExplorer(staged, key("c"))._tag).toBe("review");
  const cancelled = press(reviewed, "n");
  expect(pendingChanges(cancelled)).toEqual(pendingChanges(staged));
  expect(pendingChanges(press(cancelled, "x"))).toEqual([]);
  expect(stepExplorer(press(staged, "q"), key("q"))._tag).toBe("quit");
  const applied = withAppliedEntries(staged, nestedFolders, {
    phase: "result",
    title: "Applied",
    lines: [],
  });
  expect(pendingChanges(press(applied, "return"))).toEqual([]);
});

it("shows effective all/some/none counts and skipped descendants on the folder", () => {
  expect(frame(initial())).toContain("Included: some (1/3)");
  const staged = press(initial(), "i");
  expect(frame(staged)).toContain("Included: all (3/3)");
  expect(frame(staged)).toContain("Staged: some (2/5)");
  expect(frame(staged)).toContain("1 locked, 1 unavailable");
  expect(frame(press(staged, "i"))).toContain("Included: some (1/3)");
  expect(frame(staged)).toContain("i again: unstage all · x: exclude all");
});

it("keeps folder details inside narrow terminal columns", () => {
  expect(frameLines(initial(), 80).every((line) => Array.from(line).length <= 79)).toBe(true);
});

it("keeps staging after a failed reload and names every descendant of a filtered folder", () => {
  const excluded = press(initial(), "x");
  const failed = withAppliedEntries(excluded, undefined, {
    phase: "result",
    title: "Failed",
    lines: [],
  });
  expect(pendingChanges(press(failed, "return"))).toEqual(pendingChanges(excluded));
  const filtered = on({ ...initial(), query: "alpha" }, "00_effect");
  expect(frame(filtered, 140)).toContain("all 5 descendants");
});

it("counts staged docs and leaves read-only folder actions unavailable", () => {
  const state = editing([docs("doc-0", false), docs("doc-1", true)], project);
  expect(frame(state, 140)).toContain("Attached: some (1/2)");
  expect(frame(press(state, "a"), 140)).toContain("Attached: all (2/2)");
  expect(frame(press(state, "a", "a"), 140)).toContain("Attached: some (1/2)");
  expect(frame(initialExplorerState("Read only", nestedFolders), 140)).not.toContain("Included:");
});

const authoring = () =>
  on(
    editing([member("kept", true), member("added", false), locked, unavailable], profile),
    "skills/00_effect",
  );

it("shows membership counts and member actions on authoring folders", () => {
  const state = authoring();
  expect(frame(state)).toContain("Members: some (1/2)");
  expect(frame(state)).toContain("i: include the rest · x: exclude the rest");
  expect(frame(state)).not.toContain("Included:");
  expect(frame(press(state, "i"))).toContain("Members: all (2/2)");
  expect(frame(press(state, "x"))).toContain("Members: none (0/2)");
});

it("clears folder staging when pending edits are discarded for a new destination", () => {
  const state = { ...authoring(), destinations: [{ label: "user", destination: user }] };
  const staged = press(on(press(on(state, "added"), "i"), "skills/00_effect"), "x");
  const discarded = press(staged, "d", "d", "escape");
  expect(pendingChanges(discarded)).toEqual([]);
});
