import { expect, it } from "vitest";
import { builtinSkillLockReason } from "../src/domain/choices/builtin.ts";
import type { ExplorerDestination } from "../src/cli/explorer/destination.ts";
import {
  fixedSelectionReason,
  initialEditState,
  type PendingChange,
} from "../src/cli/explorer/edit.ts";
import {
  initialExplorerState,
  pendingChanges,
  type ExplorerEntry,
  type ExplorerState,
} from "../src/cli/explorer/model.ts";
import {
  active,
  choice,
  copy,
  docs,
  editing,
  fixed,
  footer,
  frame,
  hint,
  inactive,
  locked,
  member,
  nestedFolders,
  on,
  press,
  profile,
  project,
  skillAddress,
  sourceRegistrationId,
  unavailable,
  user,
  viaUser,
} from "./support/explorer.ts";

const decide = (decision: "include" | "exclude" | "unset") => (name: string) =>
  ({ kind: "choice", address: skillAddress(name), decision }) satisfies PendingChange;
const include = decide("include");
const exclude = decide("exclude");
const unset = decide("unset");
const joins = (name: string) =>
  ({ kind: "member", address: skillAddress(name), included: true }) satisfies PendingChange;
const leaves = (name: string) =>
  ({ kind: "member", address: skillAddress(name), included: false }) satisfies PendingChange;
const attaches = (name: string, attached = true) =>
  ({ kind: "docs", resource: { sourceRegistrationId, name }, attached }) satisfies PendingChange;

/** What the session shows after the keys: each field present is asserted exactly. */
type Expected = {
  readonly pending?: ReadonlyArray<PendingChange>;
  readonly notice?: string;
  readonly hint?: string;
  readonly footer?: string;
  readonly shows?: ReadonlyArray<string>;
  readonly hides?: ReadonlyArray<string | RegExp>;
};

/**
 * One staging case: the rows of a session, the destination it stages for (none for a read-only
 * session), the keys pressed in order (`@label` moves the cursor to that row or folder) and what the
 * session shows afterwards.
 */
type StagingCase = readonly [
  name: string,
  entries: ReadonlyArray<ExplorerEntry>,
  destination: ExplorerDestination | undefined,
  keys: ReadonlyArray<string>,
  expected: Expected,
];

const across = (
  destinations: ReadonlyArray<ExplorerDestination>,
  cases: ReadonlyArray<StagingCase>,
): ReadonlyArray<StagingCase> =>
  destinations.flatMap((destination) =>
    cases.map(
      ([name, entries, , keys, expected]) =>
        [`${name} (${destination._tag})`, entries, destination, keys, expected] as const,
    ),
  );

const pair = [choice("beta"), choice("gamma")];
const savedInclude = [choice("alpha", "include")];
const membership = [member("added", false), member("kept", true)];
const builtins = [locked, unavailable];
const folder = "skills/00_effect";
const choiceFolder = [
  choice("alpha", "include"),
  choice("beta", "exclude"),
  choice("nested"),
  locked,
  unavailable,
];
const memberFolder = [member("kept", true), member("added", false), locked, unavailable];
const docsFolder = [docs("one", false), docs("two", true)];
const noneCan = (action: string) => `No descendants can ${action} here.`;

const cases: ReadonlyArray<StagingCase> = [
  ...across(
    [user, project],
    [
      [
        "an unstaged choice offers both keys",
        pair,
        user,
        ["@beta"],
        {
          pending: [],
          hint: "i: include · x: exclude",
          footer: "i include  x exclude",
          shows: ["Not staged"],
        },
      ],
      [
        "i stages an include",
        pair,
        user,
        ["@beta", "i"],
        {
          pending: [include("beta")],
          hint: "i again: unstage · x: exclude instead",
          footer: "i unstage  x exclude",
          shows: ["Staged: include"],
        },
      ],
      [
        "i again unstages the include",
        pair,
        user,
        ["@beta", "i", "i"],
        { pending: [], footer: "i include  x exclude" },
      ],
      [
        "x stages an exclude",
        pair,
        user,
        ["@beta", "x"],
        {
          pending: [exclude("beta")],
          hint: "x again: unstage · i: include instead",
          footer: "i include  x unstage",
        },
      ],
      ["x again unstages the exclude", pair, user, ["@beta", "x", "x"], { pending: [] }],
      [
        "i switches a staged exclude",
        pair,
        user,
        ["@beta", "x", "i"],
        { pending: [include("beta")] },
      ],
      [
        "x switches a staged include",
        pair,
        user,
        ["@beta", "i", "x"],
        { pending: [exclude("beta")] },
      ],
      [
        "the footer follows the cursor to another row",
        pair,
        user,
        ["@beta", "i", "@gamma"],
        { pending: [include("beta")], footer: "i include  x exclude" },
      ],
    ],
  ),
  [
    "u unstages the selected row",
    pair,
    user,
    ["@beta", "i", "u"],
    { pending: [], footer: "i include  x exclude", hides: ["remove"] },
  ],
  [
    "a staged row offers u in the details",
    pair,
    user,
    ["@beta", "x"],
    { footer: "i include  x unstage", shows: ["u: unstage"] },
  ],
  [
    "u on a row with nothing staged says so",
    pair,
    user,
    ["@beta", "u"],
    { pending: [], notice: "Nothing is staged here." },
  ],
  [
    "r stages a reset of a saved pick",
    savedInclude,
    user,
    ["@alpha", "r"],
    {
      pending: [unset("alpha")],
      shows: ["→reset", "Staged: reset to default (removes the saved pick)", "r again: unstage"],
    },
  ],
  ["r again unstages the reset", savedInclude, user, ["@alpha", "r", "r"], { pending: [] }],
  [
    "r replaces a staged change on a saved pick",
    savedInclude,
    user,
    ["@alpha", "x", "r"],
    { pending: [unset("alpha")] },
  ],
  [
    "r on a row without a saved pick drops its staged change",
    pair,
    user,
    ["@beta", "i", "r"],
    { pending: [] },
  ],
  [
    "r on a row at its default says so",
    pair,
    user,
    ["@beta", "r"],
    { pending: [], notice: "Already at its default." },
  ],
  [
    "a saved pick offers r in the details",
    savedInclude,
    user,
    ["@alpha"],
    { footer: "i reset  x exclude", shows: ["r: reset to default"] },
  ],
  [
    "a saved exclude leaves r to the details when x already resets",
    [choice("beta", "exclude")],
    user,
    ["@beta"],
    { footer: "i include  x reset", hides: ["r reset"] },
  ],
  [
    "r on a docs row is refused",
    [docs("handbook", true)],
    project,
    ["@handbook", "r"],
    { pending: [], notice: "Docs are attached with a." },
  ],
  ...["u", "r"].map(
    (action) =>
      [
        `${action} with no row selected asks for one`,
        [],
        user,
        [action],
        { pending: [], notice: "Select a resource first." },
      ] as const,
  ),
  [
    "u and r stage nothing in a read-only session",
    savedInclude,
    undefined,
    ["@alpha", "r", "u"],
    { pending: [] },
  ],
  [
    "an active row shows its state for the destination",
    [active("beta", "default")],
    project,
    ["@beta"],
    { shows: ["● default", "Not staged"], hides: ["→"] },
  ],
  [
    "an inactive row shows why",
    [inactive("beta", "excluded", "exclude")],
    project,
    ["@beta"],
    { shows: ["○ excluded"] },
  ],
  [
    "i on an active default row is an explicit pick with no link change",
    [active("beta", "default")],
    project,
    ["@beta", "i"],
    {
      pending: [include("beta")],
      shows: ["● default → include", "Staged: include (already active, no link change)"],
    },
  ],
  [
    "x on an inactive row is an explicit pick with no link change",
    [inactive("beta", "opt-in")],
    project,
    ["@beta", "x"],
    {
      pending: [exclude("beta")],
      shows: ["○ opt-in → exclude", "Staged: exclude (already inactive, no link change)"],
    },
  ],
  [
    "i on an excluded row says what it changes",
    [inactive("beta", "excluded", "exclude")],
    project,
    ["@beta", "i"],
    {
      pending: [include("beta")],
      shows: ["○ excluded → include", "Staged: include"],
      hides: ["no link change"],
    },
  ],
  [
    "a folder counts its active descendants",
    [
      active("alpha", "included", "include"),
      inactive("beta", "excluded", "exclude"),
      active("nested", "dependency"),
    ],
    project,
    [`@${folder}`],
    { shows: ["2/3 active", "Active: some (2/3)"] },
  ],
  [
    "u unstages every staged descendant of a folder",
    choiceFolder,
    user,
    ["@nested", "i", `@${folder}`, "u"],
    { pending: [], notice: "1 descendant: unstage. 2 skipped." },
  ],
  [
    "u on a folder with nothing staged says so",
    choiceFolder,
    user,
    [`@${folder}`, "u"],
    { pending: [], notice: "Nothing is staged here." },
  ],
  [
    "r resets every saved pick of a folder",
    choiceFolder,
    user,
    [`@${folder}`],
    { hint: "i: include the rest · x: exclude the rest", shows: ["r: reset all to default"] },
  ],
  [
    "r stages the resets of a folder",
    choiceFolder,
    user,
    [`@${folder}`, "r"],
    {
      pending: [unset("alpha"), unset("beta")],
      notice: "2 descendants: reset to default. 2 skipped.",
    },
  ],
  [
    "r again unstages the resets of a folder",
    choiceFolder,
    user,
    [`@${folder}`, "r", "r"],
    { pending: [], notice: "2 descendants: unstage. 2 skipped." },
  ],
  [
    "a folder whose resets are staged offers r to unstage them",
    choiceFolder,
    user,
    [`@${folder}`, "r"],
    { shows: ["r again: unstage all", "u: unstage all"] },
  ],
  [
    "r on a folder at its defaults says so",
    [choice("one"), choice("two")],
    user,
    [`@${folder}`, "r"],
    { pending: [], notice: "All 2 descendants are already at their default." },
  ],
  [
    "a saved include offers a reset",
    savedInclude,
    user,
    ["@alpha"],
    { pending: [], hint: "i: reset to default · x: exclude", footer: "i reset  x exclude" },
  ],
  [
    "i resets a saved include",
    savedInclude,
    user,
    ["@alpha", "i"],
    { pending: [unset("alpha")], hint: "i again: unstage · x: exclude instead" },
  ],
  ["i again unstages the reset", savedInclude, user, ["@alpha", "i", "i"], { pending: [] }],
  [
    "x excludes a saved include",
    savedInclude,
    user,
    ["@alpha", "x"],
    { pending: [exclude("alpha")], hint: "x again: unstage · i: include instead" },
  ],
  ["x again unstages that exclude", savedInclude, user, ["@alpha", "x", "x"], { pending: [] }],
  [
    "i back to the saved include stages nothing",
    savedInclude,
    user,
    ["@alpha", "x", "i"],
    {
      pending: [],
    },
  ],
  [
    "a read-only session stages nothing",
    [...pair, ...savedInclude, docs("handbook", false)],
    undefined,
    ["@beta", "i", "x", "@alpha", "x", "@handbook", "a"],
    { pending: [] },
  ],
  [
    "a detached docs row offers attach",
    [docs("handbook", false)],
    project,
    ["@handbook"],
    { pending: [], hint: "a: attach", footer: "i include  x exclude" },
  ],
  [
    "a stages the attachment",
    [docs("handbook", false)],
    project,
    ["@handbook", "a"],
    { pending: [attaches("handbook")], hint: "a again: unstage" },
  ],
  [
    "a again unstages it",
    [docs("handbook", false)],
    project,
    ["@handbook", "a", "a"],
    {
      pending: [],
    },
  ],
  ["a docs row ignores i", [docs("handbook", false)], project, ["@handbook", "i"], { pending: [] }],
  [
    "an attached docs row offers detach",
    [docs("guide", true)],
    project,
    ["@guide"],
    {
      hint: "a: detach",
    },
  ],
  ...across(
    [profile, copy],
    [
      [
        "a non-member offers include",
        membership,
        user,
        ["@added"],
        { pending: [], hint: "i: include", footer: "i include  x exclude" },
      ],
      [
        "x on a non-member says it is already excluded",
        membership,
        user,
        ["@added", "x"],
        { pending: [], notice: "Already excluded." },
      ],
      [
        "i adds a member",
        membership,
        user,
        ["@added", "i"],
        {
          pending: [joins("added")],
          hint: "i again: unstage · x: exclude instead",
          footer: "i unstage  x exclude",
        },
      ],
      [
        "i again unstages the addition",
        membership,
        user,
        ["@added", "i", "i"],
        { pending: [], footer: "i include  x exclude" },
      ],
      ["x unstages the addition", membership, user, ["@added", "i", "x"], { pending: [] }],
      [
        "the footer follows the cursor to a member",
        membership,
        user,
        ["@added", "i", "@kept"],
        { pending: [joins("added")], footer: "i include  x exclude" },
      ],
      ["a member offers exclude", membership, user, ["@kept"], { hint: "x: exclude" }],
      [
        "i on a member says it is already included",
        membership,
        user,
        ["@kept", "i"],
        { pending: [], notice: "Already included." },
      ],
      [
        "x removes a member",
        membership,
        user,
        ["@kept", "x"],
        {
          pending: [leaves("kept")],
          hint: "x again: unstage · i: include instead",
          footer: "i include  x unstage",
          shows: ["Staged: exclude", "→exclude"],
        },
      ],
      ["x again unstages the removal", membership, user, ["@kept", "x", "x"], { pending: [] }],
    ],
  ),
  ...across(
    [user, profile, copy],
    [
      [
        "a built-in row has no key hint",
        builtins,
        user,
        ["@locked"],
        { hint: "", footer: "i include  x exclude" },
      ],
      ...["i", "x", "a"].map(
        (action) =>
          [
            `${action} on a built-in row is refused`,
            builtins,
            user,
            ["@locked", action],
            { pending: [], notice: builtinSkillLockReason },
          ] as const,
      ),
      [
        "an unavailable row keeps the footer",
        builtins,
        user,
        ["@script"],
        {
          footer: "i include  x exclude",
        },
      ],
      [
        "a folder of locked and unavailable rows has no key hint",
        builtins,
        user,
        [`@${folder}`],
        { hint: "", footer: "i include  x exclude" },
      ],
    ],
  ),
  ...["i", "x", "a"].map(
    (action) =>
      [
        `${action} on a folder of locked and unavailable rows is refused`,
        builtins,
        user,
        [`@${folder}`, action],
        {
          pending: [],
          notice: noneCan({ i: "include", x: "exclude", a: "attach" }[action] ?? action),
        },
      ] as const,
  ),
  [
    "a partial folder offers the rest",
    choiceFolder,
    user,
    [`@${folder}`],
    {
      pending: [],
      hint: "i: include the rest · x: exclude the rest",
      footer: "i include  x exclude  r reset",
    },
  ],
  [
    "i stages the rest of a folder and skips locked and unavailable rows",
    choiceFolder,
    user,
    [`@${folder}`, "i"],
    {
      pending: [include("beta"), include("nested")],
      notice: "2 descendants: include. 2 skipped.",
      hint: "i again: unstage all · x: exclude all",
      footer: "i unstage  x exclude  r reset",
    },
  ],
  [
    "i again unstages the folder",
    choiceFolder,
    user,
    [`@${folder}`, "i", "i"],
    {
      pending: [],
      notice: "2 descendants: unstage. 2 skipped.",
      footer: "i include  x exclude  r reset",
    },
  ],
  [
    "x again unstages a fully excluded folder",
    choiceFolder,
    user,
    [`@${folder}`, "x", "x"],
    { pending: [], notice: "2 descendants: unstage. 2 skipped." },
  ],
  [
    "a row staged first counts toward its folder",
    choiceFolder,
    user,
    ["@nested", "x", `@${folder}`],
    { pending: [exclude("nested")], hint: "i: include the rest · x: exclude the rest" },
  ],
  [
    "the folder then stages only the rest",
    choiceFolder,
    user,
    ["@nested", "x", `@${folder}`, "x"],
    { pending: [exclude("nested"), exclude("alpha")] },
  ],
  [
    "x again unstages the folder and the row",
    choiceFolder,
    user,
    ["@nested", "x", `@${folder}`, "x", "x"],
    { pending: [] },
  ],
  [
    "a on a choice folder stages nothing",
    choiceFolder,
    user,
    [`@${folder}`, "a"],
    { pending: [], notice: noneCan("attach") },
  ],
  [
    "a read-only folder stages nothing",
    choiceFolder,
    undefined,
    [`@${folder}`, "i"],
    {
      pending: [],
    },
  ],
  ...across(
    [user, project],
    [
      [
        "i stages deeper descendants and leaves sibling folders and sources alone",
        nestedFolders,
        user,
        ["@00_effect", "i"],
        { pending: [include("beta"), include("nested")] },
      ],
      [
        "x switches the whole folder",
        nestedFolders,
        user,
        ["@00_effect", "i", "x"],
        { pending: [exclude("nested"), exclude("alpha")] },
      ],
      ["i again unstages it", nestedFolders, user, ["@00_effect", "i", "i"], { pending: [] }],
    ],
  ),
  [
    "a folder whose saved choices match offers a reset",
    [choice("alpha", "include"), choice("beta", "include")],
    user,
    [`@${folder}`],
    { hint: "i: reset all to default · x: exclude all", footer: "i reset  x exclude" },
  ],
  [
    "i resets every saved choice of the folder",
    [choice("alpha", "include"), choice("beta", "include")],
    user,
    [`@${folder}`, "i"],
    {
      pending: [unset("alpha"), unset("beta")],
      notice: "2 descendants: reset to default. 0 skipped.",
      hint: "i: include all · x: exclude all",
    },
  ],
  [
    "i again unstages the reset",
    [choice("alpha", "include"), choice("beta", "include")],
    user,
    [`@${folder}`, "i", "i"],
    { pending: [] },
  ],
  ...across(
    [profile, copy],
    [
      [
        "a partial membership folder offers the rest",
        memberFolder,
        user,
        [`@${folder}`],
        { hint: "i: include the rest · x: exclude the rest", footer: "i include  x exclude" },
      ],
      [
        "i adds the rest of the folder",
        memberFolder,
        user,
        [`@${folder}`, "i"],
        {
          pending: [joins("added")],
          notice: "1 descendant: include. 2 skipped.",
          hint: "i again: unstage all · x: exclude all",
        },
      ],
      [
        "i again unstages the additions",
        memberFolder,
        user,
        [`@${folder}`, "i", "i"],
        { pending: [], notice: "1 descendant: unstage. 2 skipped." },
      ],
      [
        "x then excludes the whole folder",
        memberFolder,
        user,
        [`@${folder}`, "i", "x"],
        {
          pending: [leaves("kept")],
        },
      ],
      [
        "x removes every member of the folder",
        memberFolder,
        user,
        [`@${folder}`, "x"],
        { pending: [leaves("kept")], hint: "x again: unstage all · i: include all" },
      ],
      [
        "x again unstages the removals",
        memberFolder,
        user,
        [`@${folder}`, "x", "x"],
        {
          pending: [],
        },
      ],
      [
        "a on a membership folder stages nothing",
        memberFolder,
        user,
        [`@${folder}`, "a"],
        {
          pending: [],
          notice: noneCan("attach"),
        },
      ],
      [
        "a folder of members offers only exclude",
        [member("kept", true)],
        user,
        [`@${folder}`],
        { hint: "x: exclude all" },
      ],
      [
        "i on a folder of members says they are included",
        [member("kept", true)],
        user,
        [`@${folder}`, "i"],
        { pending: [], notice: "All 1 descendants are already included." },
      ],
    ],
  ),
  [
    "a partly attached docs folder offers the rest",
    docsFolder,
    project,
    [`@${folder}`],
    { hint: "a: attach the rest" },
  ],
  [
    "a attaches the rest of the docs folder",
    docsFolder,
    project,
    [`@${folder}`, "a"],
    { pending: [attaches("one")], hint: "a again: unstage all" },
  ],
  [
    "a again unstages the attachments",
    docsFolder,
    project,
    [`@${folder}`, "a", "a"],
    { pending: [], notice: "1 descendant: unstage. 0 skipped." },
  ],
  [
    "i on a docs folder stages nothing",
    docsFolder,
    project,
    [`@${folder}`, "i"],
    {
      pending: [],
      notice: noneCan("include"),
    },
  ],
  [
    "x on a docs folder stages nothing",
    docsFolder,
    project,
    [`@${folder}`, "x"],
    {
      pending: [],
      notice: noneCan("exclude"),
    },
  ],
  [
    "an attached docs folder offers detach",
    [docs("two", true)],
    project,
    [`@${folder}`],
    {
      hint: "a: detach all",
    },
  ],
  [
    "a detaches every attached docs row",
    [docs("two", true)],
    project,
    [`@${folder}`, "a"],
    { pending: [attaches("two", false)] },
  ],
  [
    "a row of a fixed project is read-only and names its profile",
    [fixed],
    project,
    ["@pinned"],
    {
      hint: "",
      footer: "i include  x exclude",
      shows: ["○ not a member", "This selection is fixed by profile kit/ci."],
      hides: ["Not staged"],
    },
  ],
  ...["i", "x", "a", "r"].map(
    (action) =>
      [
        `${action} on a row of a fixed project is refused`,
        [fixed],
        project,
        ["@pinned", action],
        { pending: [], notice: fixedSelectionReason("kit/ci") },
      ] as const,
  ),
  [
    "i on a folder of a fixed project is refused",
    [fixed],
    project,
    [`@${folder}`, "i"],
    { pending: [], notice: noneCan("include") },
  ],
  [
    "a row the user scope brings in says so",
    [viaUser],
    project,
    ["@shared"],
    { shows: ["○ opt-in · via user"] },
  ],
];

const session = (
  entries: ReadonlyArray<ExplorerEntry>,
  destination: ExplorerDestination | undefined,
  keys: ReadonlyArray<string>,
): ExplorerState =>
  keys.reduce(
    (state, step) => (step.startsWith("@") ? on(state, step.slice(1)) : press(state, step)),
    destination === undefined
      ? initialExplorerState("Browse", entries)
      : editing(entries, destination),
  );

it.each(cases)("%s", (_name, entries, destination, keys, expected) => {
  const state = session(entries, destination, keys);
  if (expected.pending !== undefined) expect(pendingChanges(state)).toEqual(expected.pending);
  if (expected.notice !== undefined) expect(state.edit?.notice).toBe(expected.notice);
  if (expected.hint !== undefined) expect(hint(state)).toBe(expected.hint);
  if (expected.footer !== undefined) expect(footer(state)).toBe(expected.footer);
  for (const text of expected.shows ?? []) expect(frame(state)).toContain(text);
  for (const text of expected.hides ?? []) expect(frame(state)).not.toMatch(text);
});

it("names the fixing profile and read-only in the header", () => {
  const state = { ...editing([fixed], project), edit: initialEditState(project, "kit/ci") };
  expect(frame(state)).toContain("editing project demo  ·  fixed by kit/ci, read-only");
  expect(frame(editing([fixed], project))).toContain("editing project demo  ·  0 staged");
});

it.each([90, 100, 120])("wraps the details panel at spaces at %i columns", (columns) => {
  const text = frame(on(editing([fixed], project), "pinned"), columns);
  for (const word of fixedSelectionReason("kit/ci").split(" ")) expect(text).toContain(word);
});
