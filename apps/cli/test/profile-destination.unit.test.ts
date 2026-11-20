import { expect, it } from "vitest";
import {
  destinationMenuLines,
  stepDestination,
} from "../src/cli/host/human/explorer/destination.ts";
import { initialExplorerState } from "../src/cli/host/human/explorer/model.ts";

it("accepts q inside a profile name and keeps the selected destination visible in a long list", () => {
  const state = {
    ...initialExplorerState("Tack", []),
    destinationMenu: { phase: "name", sourcePath: "/source", text: "" } as const,
  };
  const typed = stepDestination(state, { name: "q", input: "q", ctrl: false });
  expect(typed).toMatchObject({ state: { destinationMenu: { phase: "name", text: "q" } } });
  const options = Array.from({ length: 30 }, (_, index) => ({
    label: `Profile ${index}`,
    destination: {
      _tag: "profile",
      sourcePath: "/source",
      profileName: `ci-${index}`,
      create: false,
    } as const,
  }));
  const lines = destinationMenuLines({ phase: "choose", cursor: 25 }, options, 10);
  expect(lines.length).toBeLessThanOrEqual(10);
  expect(lines.join("\n")).toContain("› Profile 25");
});

it("groups the chooser by kind, aligns notes and keeps headings out of the cursor", () => {
  const options = [
    { label: "Browse only", destination: { _tag: "browse" } },
    { label: "User", group: "Daily selections", destination: { _tag: "user" } },
    {
      label: "Project gamma",
      group: "Daily selections",
      note: "fixed by kit/ci (read-only)",
      destination: { _tag: "project", projectName: "gamma" },
    },
    {
      label: "kit/ci",
      group: "Profiles",
      note: "applied to gamma",
      destination: { _tag: "profile", sourcePath: "/kit", profileName: "ci", create: false },
    },
  ] as const;
  expect(destinationMenuLines({ phase: "choose", cursor: 2 }, options)).toEqual([
    "Choose destination",
    "",
    "  Browse only",
    "Daily selections",
    "    User",
    "  › Project gamma  fixed by kit/ci (read-only)",
    "Profiles",
    "    kit/ci  applied to gamma",
    "",
    "↑↓ choose  Enter open  Esc cancel",
  ]);
  // A heading never takes the cursor: down from Browse only lands on User.
  const state = {
    ...initialExplorerState("Tack", []),
    destinations: options,
    destinationMenu: { phase: "choose", cursor: 0 } as const,
  };
  expect(stepDestination(state, { name: "down", ctrl: false })).toMatchObject({
    state: { destinationMenu: { cursor: 1 } },
  });
});

it("requires an explicit pending-edit disposition and validates names before switching", () => {
  const initial = initialExplorerState("Tack", []);
  const pending = { ...initial, destinationMenu: { phase: "pending" } as const };
  expect(stepDestination(pending, { name: "s", input: "s", ctrl: false })).toMatchObject({
    _tag: "review",
  });
  expect(stepDestination(pending, { name: "z", input: "z", ctrl: false })).toMatchObject({
    state: { destinationMenu: { phase: "pending" } },
  });
  expect(stepDestination(pending, { name: "d", input: "d", ctrl: false })).toMatchObject({
    state: { destinationMenu: { phase: "choose" } },
  });
  const named = {
    ...initial,
    destinationMenu: { phase: "name", sourcePath: "/source", text: "ci?" } as const,
  };
  expect(stepDestination(named, { name: "return", ctrl: false })).toMatchObject({ _tag: "next" });
  expect(stepDestination(named, { name: "backspace", ctrl: false })).toMatchObject({
    state: { destinationMenu: { text: "ci" } },
  });
  expect(
    stepDestination(
      { ...initial, destinationMenu: { phase: "choose", cursor: 0 } },
      { name: "return", ctrl: false },
    ),
  ).toMatchObject({ _tag: "next" });
  expect(stepDestination(initial, { name: "z", ctrl: false })).toBeUndefined();
});

it("names the copy review confirmation as source/name choice before the final file save", async () => {
  const { renderExplorerFrame } = await import("../src/cli/host/human/explorer/frame.ts");
  const { makeStyle } = await import("../src/cli/host/human/style.ts");
  const { withReview } = await import("../src/cli/host/human/explorer/model.ts");
  const { initialEditState } = await import("../src/cli/host/human/explorer/edit.ts");
  const state = withReview(
    {
      ...initialExplorerState("Tack", []),
      edit: initialEditState({ _tag: "copy", input: { user: true, projectName: "demo" } }),
    },
    { phase: "preview", title: "Review membership", lines: [] },
  );
  expect(
    renderExplorerFrame(
      state,
      { rows: 24, columns: 120 },
      makeStyle({ color: false, width: 120, homeDirectory: undefined }),
    ),
  ).toContain("y choose source/name");
});
