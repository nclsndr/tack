import { Effect, type Terminal } from "effect";
import { expect } from "vitest";
import type { ExplorerActivity } from "../../src/cli/host/human/explorer/activity.ts";
import type { ExplorerDestination } from "../../src/cli/host/human/explorer/destination.ts";
import { initialEditState } from "../../src/cli/host/human/explorer/edit.ts";
import { renderExplorerFrame } from "../../src/cli/host/human/explorer/frame.ts";
import {
  initialExplorerState,
  stepExplorer,
  visibleRows,
  type ExplorerEntry,
  type ExplorerKey,
  type ExplorerState,
} from "../../src/cli/host/human/explorer/model.ts";
import { makeStyle } from "../../src/cli/host/human/style.ts";

export const sourceRegistrationId = "00000000-0000-4000-8000-000000000001";

/**
 * The `size` of a scripted terminal. The explorer takes resizes from the process, never from
 * `Terminal.size`, so reading it is a test bug.
 */
export const unwatchedTerminalSize: Terminal.Terminal["size"] = Effect.die(
  "The explorer read Terminal.size; it takes resizes from the process.",
);

export const user = { _tag: "user" } as const;
export const project = { _tag: "project", projectName: "demo" } as const;
export const profile = {
  _tag: "profile",
  sourcePath: "/src",
  profileName: "team",
  create: false,
} as const;
export const copy = { _tag: "copy", input: { user: true } } as const;

/** The address of the skill `name` in the fixture source. */
export const skillAddress = (name: string) =>
  ({ kind: "skill", sourceRegistrationId, name }) as const;

/** A read-only skill row in the `example` source, under `skills/00_effect`. */
const entry = (name: string): ExplorerEntry => ({
  id: name,
  section: "Skills",
  title: name,
  description: "",
  tags: [],
  facts: [],
  issue: false,
  address: skillAddress(name),
  tree: { source: "example", folders: ["skills", "00_effect"] },
});

/** A skill row whose saved choice is `current`, or no choice. */
export const choice = (name: string, current?: "include" | "exclude"): ExplorerEntry => ({
  ...entry(name),
  editable: { kind: "choice", address: skillAddress(name), current },
});

/** A skill row active in the edited destination for `reason`, with its saved choice. */
export const active = (
  name: string,
  reason: ExplorerActivity["reason"],
  current?: "include" | "exclude",
): ExplorerEntry => ({ ...choice(name, current), activity: { active: true, reason } });

/** A skill row inactive in the edited destination for `reason`, with its saved choice. */
export const inactive = (
  name: string,
  reason: ExplorerActivity["reason"],
  current?: "include" | "exclude",
): ExplorerEntry => ({ ...choice(name, current), activity: { active: false, reason } });

/** A skill row of an authored profile or copy, a member when `included`. */
export const member = (name: string, included: boolean): ExplorerEntry => ({
  ...entry(name),
  editable: { kind: "member", address: skillAddress(name), included },
});

/** A docs row, attached to the project when `attached`. */
export const docs = (name: string, attached: boolean): ExplorerEntry => ({
  ...entry(name),
  section: "Docs",
  editable: { kind: "docs", resource: { sourceRegistrationId, name }, attached },
});

/** A built-in skill row, which no key may stage. */
export const locked = { ...entry("locked"), editable: { kind: "builtin" } } satisfies ExplorerEntry;

/** A row of a project that the profile `kit/ci` fixes: read-only, and not one of its members. */
export const fixed = {
  ...entry("pinned"),
  editable: { kind: "fixed", profile: "kit/ci" },
  activity: { active: false, reason: "not a member" },
} satisfies ExplorerEntry;

/** A row of an opt-in skill the edited project does not deliver but the user scope does. */
export const viaUser = {
  ...choice("shared"),
  activity: { active: false, reason: "opt-in", viaUser: true },
} satisfies ExplorerEntry;

/** A row with nothing to stage, such as a script. */
export const unavailable = entry("script");

/** A folder with a deeper child, a sibling folder that shares a prefix and another source. */
export const nestedFolders: ReadonlyArray<ExplorerEntry> = [
  choice("alpha", "include"),
  choice("beta", "exclude"),
  { ...choice("nested"), tree: { source: "example", folders: ["skills", "00_effect", "deep"] } },
  locked,
  unavailable,
  { ...choice("sibling"), tree: { source: "example", folders: ["skills", "00_effect_extra"] } },
  { ...choice("other"), tree: { source: "other", folders: ["skills", "00_effect"] } },
];

/** A key press whose input is the key's own name, as a letter press reads. */
export const key = (name: string): ExplorerKey => ({ name, input: name, ctrl: false });

/** Presses each key in order and fails when one leaves the browsing step. */
export const press = (state: ExplorerState, ...names: ReadonlyArray<string>): ExplorerState =>
  names.reduce((latest, name) => {
    const step = stepExplorer(latest, key(name));
    if (step._tag !== "next") throw new Error(`Unexpected ${step._tag} step.`);
    return step.state;
  }, state);

/** Moves the cursor to the folder labelled `label`, or the row whose id is `label`. */
export const on = (state: ExplorerState, label: string): ExplorerState => {
  const cursor = visibleRows(state).findIndex((row) =>
    row.kind === "folder" ? row.label === label : row.entry.id === label,
  );
  expect(cursor, label).toBeGreaterThanOrEqual(0);
  return { ...state, cursor };
};

/** A browse session over `entries` that stages for `destination`. */
export const editing = (
  entries: ReadonlyArray<ExplorerEntry>,
  destination: ExplorerDestination,
): ExplorerState => ({
  ...initialExplorerState("Browse", entries),
  edit: initialEditState(destination),
});

/** The uncoloured frame at 30 rows and `columns` columns. */
export const frame = (state: ExplorerState, columns = 170): string =>
  renderExplorerFrame(
    state,
    { rows: 30, columns },
    makeStyle({ color: false, width: columns, homeDirectory: undefined }),
  );

/** The visible text of each frame line, without cursor controls or the erase-to-end marker. */
export const frameLines = (state: ExplorerState, columns = 170): ReadonlyArray<string> =>
  frame(state, columns)
    .split("\u001b[K")
    .slice(0, -1)
    .map((line) => line.slice(line.lastIndexOf("H") + 1));

/** The detail pane's key hint, the last line before the pane's trailing actions. */
export const hint = (state: ExplorerState): string => {
  const lines = frameLines(state)
    .map((line) => line.split(" │ ")[1]?.trim() ?? "")
    .filter((line) => /^[ixa]( again)?: /.test(line));
  expect(lines.length).toBeLessThanOrEqual(1);
  return lines[0] ?? "";
};

/** The footer's staging keys, between the destination and review keys. */
export const footer = (state: ExplorerState): string => {
  // A folder key leaves a notice in the footer until the next key; read the keys behind it.
  const quiet =
    state.edit === undefined ? state : { ...state, edit: { ...state.edit, notice: undefined } };
  const text = frameLines(quiet).at(-1) ?? "";
  expect(text).toMatch(/^ d destination {2}.+ {2}c review\/save {2}\/ filter {2}q quit/);
  return text.slice(" d destination  ".length, text.indexOf("  c review/save"));
};
