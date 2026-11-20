import { describe, expect, it } from "vitest";
import {
  focusAfter,
  initialFocus,
  type FocusEvent,
  type WorkspaceFocus,
} from "./workspace-focus.ts";

const review = "/home/demo/skills/skills/review/SKILL.md";
const ship = "/home/demo/skills/skills/ship/SKILL.md";
const shipFolder = "/home/demo/skills/skills/ship";
const skills = "/home/demo/skills/skills";

const run = (events: ReadonlyArray<FocusEvent>) => events.reduce(focusAfter, initialFocus);

/** The rule under test: a focused file or folder tab is the explorer's active row. */
const agrees = (focus: WorkspaceFocus) =>
  focus.view.kind !== "entry" || focus.selected === focus.view.path;

describe("workspace focus", () => {
  it.each<[string, ReadonlyArray<FocusEvent>, string | undefined]>([
    ["a file picked in the explorer", [{ kind: "pick", path: review, opens: true }], review],
    [
      "a file opened from another tab, after one picked in the explorer",
      [
        { kind: "pick", path: review, opens: true },
        { kind: "open", path: ship },
      ],
      ship,
    ],
    [
      "a tab switched back to",
      [
        { kind: "pick", path: review, opens: true },
        { kind: "open", path: ship },
        { kind: "show", view: { kind: "entry", path: review } },
      ],
      review,
    ],
    [
      "a folder opened from a link's tab",
      [
        { kind: "pick", path: review, opens: true },
        { kind: "open", path: shipFolder },
      ],
      shipFolder,
    ],
    ["the focused tab, after a command", [{ kind: "open", path: ship }, { kind: "reading" }], ship],
  ])("makes the active row %s", (_, events, selected) => {
    const focus = run(events);
    expect(focus.selected).toBe(selected);
    expect(agrees(focus)).toBe(true);
  });

  it("selects a folder picked in the explorer without opening a tab", () => {
    const focus = run([{ kind: "pick", path: skills, opens: false }]);
    expect(focus).toEqual({
      view: { kind: "agent" },
      session: "agent",
      opened: [],
      selected: skills,
    });
  });

  it("keeps one tab per path and returns to the session in front when the focused tab closes", () => {
    const focus = run([
      { kind: "open", path: ship },
      { kind: "open", path: review },
      { kind: "open", path: ship },
      { kind: "close", path: ship },
    ]);
    expect(focus).toEqual({
      view: { kind: "agent" },
      session: "agent",
      opened: [review],
      selected: undefined,
    });
  });

  it("keeps the focused tab and the selection when another tab closes", () => {
    const focus = run([
      { kind: "open", path: review },
      { kind: "open", path: ship },
      { kind: "close", path: review },
    ]);
    expect(focus).toEqual({
      view: { kind: "entry", path: ship },
      session: "agent",
      opened: [ship],
      selected: ship,
    });
  });

  it("keeps the selection when the terminal or the files pane comes forward", () => {
    const focus = run([
      { kind: "open", path: ship },
      { kind: "show", view: { kind: "terminal" } },
      { kind: "show", view: { kind: "files" } },
    ]);
    expect(focus.selected).toBe(ship);
    expect(focus.view).toEqual({ kind: "files" });
  });

  it("opens on the agent session and goes back to the terminal once it came forward", () => {
    const focus = run([
      { kind: "show", view: { kind: "terminal" } },
      { kind: "open", path: ship },
      { kind: "close", path: ship },
    ]);
    expect(initialFocus.view).toEqual({ kind: "agent" });
    expect(focus).toMatchObject({ view: { kind: "terminal" }, session: "terminal" });
  });

  it("lets a command clear a selection no tab holds", () => {
    const focus = run([{ kind: "pick", path: skills, opens: false }, { kind: "reading" }]);
    expect(focus.selected).toBeUndefined();
  });
});
