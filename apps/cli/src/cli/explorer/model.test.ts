import { describe, expect, it } from "vitest";
import {
  initialExplorerState,
  stepExplorer,
  withAppliedEntries,
  withPreview,
  withReview,
  type ExplorerEntry,
  type ExplorerKey,
  type ExplorerState,
} from "./model.ts";

const entry = (title: string): ExplorerEntry => ({
  id: `skill ${title}`,
  section: "Skills",
  title,
  description: "",
  tags: [],
  facts: [],
  issue: false,
});
const entries = Array.from({ length: 30 }, (_, index) => entry(`skill-${index}`));
const key = (name: string, input?: string, ctrl = false): ExplorerKey => ({ name, input, ctrl });

/** Steps through `keys` and returns the state after the last one that kept the session open. */
const after = (state: ExplorerState, ...keys: ReadonlyArray<ExplorerKey>): ExplorerState =>
  keys.reduce((current, next) => {
    const step = stepExplorer(current, next);
    if (step._tag === "quit" || step._tag === "interrupt")
      throw new Error(`Session ended: ${step._tag}`);
    return step.state;
  }, state);

const browsing = initialExplorerState("Catalog", entries);
const editing = initialExplorerState("Catalog", entries, { _tag: "user" });
const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);

describe("explorer keys", () => {
  it("quits on ctrl+d", () => {
    expect(stepExplorer(browsing, key("d", undefined, true))).toEqual({ _tag: "quit" });
  });

  it("scrolls a preview by line, by page and with the space bar, never past its ends", () => {
    const preview = withPreview(browsing, "SKILL.md", lines);
    const offset = (...keys: ReadonlyArray<ExplorerKey>) => after(preview, ...keys).preview?.offset;
    expect(offset(key("down"))).toBe(1);
    expect(offset(key("j", "j"), key("j", "j"), key("k", "k"))).toBe(1);
    expect(offset(key("down"), key("up"))).toBe(0);
    expect(offset(key("pagedown"))).toBe(10);
    expect(offset(key("space"))).toBe(10);
    expect(offset(key("x", " "))).toBe(10);
    expect(offset(key("pagedown"), key("pageup"))).toBe(0);
    expect(
      offset(key("pagedown"), key("pagedown"), key("pagedown"), key("pagedown"), key("pagedown")),
    ).toBe(39);
    expect(offset(key("tab"))).toBe(0);
  });

  it("scrolls a review the same way", () => {
    const review = withReview(editing, { phase: "result", title: "Applied", lines });
    const offset = (...keys: ReadonlyArray<ExplorerKey>) =>
      after(review, ...keys).edit?.review?.offset;
    expect(offset(key("j", "j"))).toBe(1);
    expect(offset(key("down"), key("k", "k"))).toBe(0);
    expect(offset(key("pagedown"), key("up"))).toBe(9);
    expect(offset(key("x", " "), key("pageup"))).toBe(0);
    expect(offset(key("space"))).toBe(10);
    expect(offset(key("tab"))).toBe(0);
  });

  it("leaves the filter on escape, keeps it on return and ignores keys that type nothing", () => {
    const filtering = after(browsing, key("slash", "/"), key("x", "1"), key("x", "5"));
    expect(filtering).toMatchObject({ filtering: true, query: "15" });
    expect(after(filtering, key("escape"))).toMatchObject({
      filtering: false,
      query: "",
      cursor: 0,
    });
    expect(after(filtering, key("return"))).toMatchObject({ filtering: false, query: "15" });
    expect(after(filtering, key("down"))).toMatchObject({ filtering: false, query: "15" });
    expect(after(filtering, key("backspace"))).toMatchObject({ filtering: true, query: "1" });
    expect(after(filtering, key("tab"))).toBe(filtering);
    expect(after(filtering, key("u", "u", true))).toBe(filtering);
  });

  it("moves the cursor by page and by line", () => {
    expect(after(browsing, key("pagedown")).cursor).toBe(10);
    expect(after(browsing, key("pagedown"), key("pageup")).cursor).toBe(0);
    expect(after(browsing, key("down"), key("down"), key("up")).cursor).toBe(1);
  });

  it("asks for a resource when staging with nothing selected", () => {
    const empty = initialExplorerState("Catalog", [], { _tag: "user" });
    expect(after(empty, key("i", "i")).edit?.notice).toBe("Select a resource first.");
  });

  it("ignores keys edit mode does not bind", () => {
    expect(after(editing, key("z", "z"))).toBe(editing);
  });
});

describe("destination menu", () => {
  const seed = [
    { address: { kind: "skill", name: "review", sourceRegistrationId: "s" }, origins: ["user"] },
  ] as const;
  const options = [
    { label: "User", destination: { _tag: "user" } },
    {
      label: "New profile in tools",
      destination: { _tag: "new-profile", sourcePath: "/src/tools", seed },
    },
  ] as const;
  const choosing: ExplorerState = {
    ...browsing,
    destinationMenu: { phase: "choose", cursor: 0, options },
  };

  it("moves between options with up and down and ignores other keys", () => {
    expect(after(choosing, key("down")).destinationMenu).toMatchObject({ cursor: 1 });
    expect(after(choosing, key("down"), key("up")).destinationMenu).toMatchObject({ cursor: 0 });
    expect(after(choosing, key("tab")).destinationMenu).toMatchObject({ cursor: 0 });
  });

  it("carries a copy's seed from a new profile through its name to the destination", () => {
    const naming = after(choosing, key("down"), key("return"));
    expect(naming.destinationMenu).toEqual({
      phase: "name",
      sourcePath: "/src/tools",
      text: "",
      seed,
    });
    const named = ["c", "i"].reduce(
      (current, letter) => after(current, key(letter, letter)),
      naming,
    );
    expect(stepExplorer(named, key("return"))).toMatchObject({
      _tag: "destination",
      destination: {
        _tag: "profile",
        sourcePath: "/src/tools",
        profileName: "ci",
        create: true,
        seed,
      },
    });
  });
});

describe("explorer state updates", () => {
  it("opens no review and reloads nothing outside edit mode", () => {
    const review = { phase: "result", title: "Applied", lines } as const;
    expect(withReview(browsing, review)).toBe(browsing);
    expect(withAppliedEntries(browsing, [], review)).toBe(browsing);
  });
});
