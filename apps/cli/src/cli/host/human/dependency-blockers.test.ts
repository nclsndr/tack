import { expect, it } from "vitest";
import { dependencyBlockerSentences } from "./dependency-blockers.ts";
import { styleOf } from "./human.test-support.ts";

const team = "11111111-1111-4111-8111-111111111111";
const me = "22222222-2222-4222-8222-222222222222";

const addresses = [
  { kind: "skill", name: "review", sourceRegistrationId: me },
  { kind: "skill", name: "review", sourceRegistrationId: team },
  { kind: "skill", name: "lint", sourceRegistrationId: team },
] as const;

const labelled = styleOf({
  references: {
    entries: addresses.map((address) => ({
      address,
      sourceRegistrationId: address.sourceRegistrationId,
    })),
    sources: [
      { registration: { id: me }, label: "me", labelOrigin: "declared" },
      { registration: { id: team }, label: "team", labelOrigin: "declared" },
    ],
  },
});

const lint = { kind: "skill", name: "lint", sourceRegistrationId: team } as const;
const namespace = { _tag: "project", projectName: "demo" } as const;
const sentences = (reason: string, dependency: object) =>
  dependencyBlockerSentences(
    {
      blockers: [
        {
          _tag: reason,
          dependency: { kind: "skill", name: "notes", ...dependency },
          requester: lint,
        },
      ],
      members: [lint],
      namespace,
    },
    labelled,
  );

it.each([
  [
    "required-missing",
    {},
    "lint needs skill notes, which no registered source provides. Register a source that provides it, or remove the dependency.",
  ],
  [
    "required-missing",
    { source: "team" },
    "lint needs skill team:notes, which team does not provide. Correct the name or the source of the dependency.",
  ],
  [
    "required-quarantined",
    {},
    "lint needs skill notes, which is quarantined. Run tack catalog to see why, then fix it.",
  ],
  [
    "required-excluded",
    { source: "me" },
    "lint needs skill me:notes, which is excluded. Run tack pick include me:notes --kind skill --project demo.",
  ],
  [
    "required-source-undeclared",
    { source: "me" },
    "lint needs skill me:notes, from a source that team does not declare. Add me to depends-on in the tack.yaml of team.",
  ],
  [
    "required-source-undeclared",
    {},
    "lint needs skill notes, from a source that team does not declare. Add that source to depends-on in the tack.yaml of team.",
  ],
  [
    "required-source-unregistered",
    { source: "base" },
    "lint needs skill base:notes, from a source that is not registered. Run tack source add with its path.",
  ],
  [
    "required-ambiguous",
    {},
    "lint needs skill notes, which several resources match. Name the source in the dependency, as source: <label>, in the requester's tack.yaml.",
  ],
] as const)("says why %s blocks and how to lift it", (reason, dependency, expected) => {
  expect(sentences(reason, dependency)).toEqual([expected]);
});

it.each([
  [
    ["/sources/base"],
    "lint needs skill base:notes, from a source Tack cannot read. A registered source is unhealthy, so its label is unknown. Run tack check /sources/base to see what to fix in it.",
  ],
  [
    ["/sources/base", "/sources/other"],
    "lint needs skill base:notes, from a source Tack cannot read. Registered sources are unhealthy, so their labels are unknown. Run tack check /sources/base and tack check /sources/other to see what to fix in them.",
  ],
] as const)(
  "points a dependency on an unreadable source at tack check of %j",
  (unhealthySources, expected) => {
    expect(
      dependencyBlockerSentences(
        {
          blockers: [
            {
              _tag: "required-source-unhealthy",
              dependency: { kind: "skill", name: "notes", source: "base" },
              requester: lint,
              unhealthySources,
            },
          ],
          members: [lint],
          namespace,
        },
        labelled,
      ),
    ).toEqual([expected]);
  },
);

it("names the user namespace and the requester's source, and ignores a subject without blockers", () => {
  expect(
    dependencyBlockerSentences(
      {
        blockers: [
          {
            _tag: "required-excluded",
            dependency: { kind: "skill", name: "notes" },
            requester: lint,
          },
        ],
        members: [],
        namespace: { _tag: "user" },
      },
      labelled,
    ),
  ).toEqual([
    "lint needs skill notes, which is excluded. Run tack pick include notes --kind skill --user.",
  ]);
  expect(
    dependencyBlockerSentences(
      {
        blockers: [
          {
            _tag: "required-source-undeclared",
            dependency: { kind: "skill", name: "notes" },
            requester: lint,
          },
        ],
        members: [],
        namespace: { _tag: "user" },
      },
      labelled,
    )[0],
  ).toContain("that team does not declare");
  expect(dependencyBlockerSentences({ members: [] }, labelled)).toEqual([]);
  expect(dependencyBlockerSentences(undefined, labelled)).toEqual([]);
});
