import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { InitialSelectionSchema, resolveInitialSelection } from "./selection.ts";
import type { ChoiceDecision, ChoiceNamespace, SkillChoice } from "./choice-schema.ts";
import type { SkillCatalogEntry } from "../sources/catalog-schema.ts";

const projectNamespace = { _tag: "project", projectName: "project" } satisfies ChoiceNamespace;
const userNamespace = { _tag: "user" } satisfies ChoiceNamespace;

const entry = (
  activation: SkillCatalogEntry["activation"],
  compatible: boolean,
  owner: "shared" | "private" = "shared",
  name = "example",
) =>
  ({
    activation,
    address: {
      kind: "skill",
      name,
      sourceRegistrationId:
        owner === "shared"
          ? "00000000-0000-4000-8000-000000000001"
          : "00000000-0000-4000-8000-000000000002",
    },
    dependencies: [],
    description: `${name} description`,
    directoryPath: `/sources/${owner}/${name}`,
    frontmatter: { description: `${name} description`, name },
    projects: compatible === true ? ["project"] : ["another-project"],
    skillFilePath: `/sources/${owner}/${name}/SKILL.md`,
    sourcePath: `/sources/${owner}`,
    sourceRegistrationId:
      owner === "shared"
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002",
  }) satisfies SkillCatalogEntry;

const choice = (
  namespace: ChoiceNamespace,
  catalogEntry: SkillCatalogEntry,
  decision: ChoiceDecision,
) => ({ address: catalogEntry.address, decision, namespace }) satisfies SkillChoice;

const projectCases = [
  ["default", true, "none", "selected", "default", "compatible"],
  ["default", false, "none", "not-selected", "project-incompatible", "incompatible"],
  ["opt-in", true, "none", "not-selected", "opt-in", "compatible"],
  ["opt-in", false, "none", "not-selected", "opt-in", "incompatible"],
  ["default", true, "include", "selected", "include", "compatible"],
  ["default", false, "include", "selected", "include", "forced"],
  ["opt-in", true, "include", "selected", "include", "compatible"],
  ["opt-in", false, "include", "selected", "include", "forced"],
  ["default", true, "exclude", "not-selected", "exclude", "compatible"],
  ["default", false, "exclude", "not-selected", "exclude", "incompatible"],
  ["opt-in", true, "exclude", "not-selected", "exclude", "compatible"],
  ["opt-in", false, "exclude", "not-selected", "exclude", "incompatible"],
] as const;

it.each(projectCases)(
  "resolves project activation=%s compatible=%s choice=%s",
  (activation, compatible, decision, selectedTag, reason, compatibility) => {
    const catalogEntry = entry(activation, compatible);
    const choices = decision === "none" ? [] : [choice(projectNamespace, catalogEntry, decision)];

    const resolved = resolveInitialSelection({
      choices,
      entries: [catalogEntry],
      namespace: projectNamespace,
    });

    expect(resolved.decisions).toMatchObject([{ _tag: selectedTag, compatibility, reason }]);
  },
);

const userCases = [
  ["default", "none", "not-selected", "opt-in"],
  ["opt-in", "none", "not-selected", "opt-in"],
  ["default", "include", "selected", "include"],
  ["opt-in", "include", "selected", "include"],
  ["default", "exclude", "not-selected", "exclude"],
  ["opt-in", "exclude", "not-selected", "exclude"],
] as const;

it.each(userCases)(
  "ignores project compatibility for user activation=%s choice=%s",
  (activation, decision, selectedTag, reason) => {
    const catalogEntry = entry(activation, false);
    const choices = decision === "none" ? [] : [choice(userNamespace, catalogEntry, decision)];

    const resolved = resolveInitialSelection({
      choices,
      entries: [catalogEntry],
      namespace: userNamespace,
    });

    expect(resolved.decisions).toMatchObject([
      { _tag: selectedTag, compatibility: "not-applicable", reason },
    ]);
  },
);

it("matches choices by exact address and isolates namespaces", () => {
  const shared = entry("default", true, "shared", "same-name");
  const privateEntry = entry("default", true, "private", "same-name");
  const resolved = resolveInitialSelection({
    choices: [
      choice(projectNamespace, shared, "exclude"),
      choice(userNamespace, privateEntry, "exclude"),
    ],
    entries: [privateEntry, shared],
    namespace: projectNamespace,
  });

  expect(resolved.decisions).toMatchObject([
    { _tag: "not-selected", address: {}, reason: "exclude" },
    { _tag: "selected", address: {}, reason: "default" },
  ]);
  expect(resolved.unresolvedChoices).toEqual([]);
});

it("references each decided resource by its address alone", () => {
  const decided = entry("default", true);

  const resolved = resolveInitialSelection({
    choices: [],
    entries: [decided],
    namespace: projectNamespace,
  });

  expect(resolved.decisions).toEqual([
    { _tag: "selected", address: decided.address, compatibility: "compatible", reason: "default" },
  ]);
});

it("treats an empty project list as compatible with every project", () => {
  const universal = { ...entry("default", false), projects: [] } satisfies SkillCatalogEntry;

  const resolved = resolveInitialSelection({
    choices: [],
    entries: [universal],
    namespace: projectNamespace,
  });

  expect(resolved.decisions).toMatchObject([
    { _tag: "selected", compatibility: "compatible", reason: "default" },
  ]);
});

it("retains unresolved choices and applies them when the exact entry returns", () => {
  const returning = entry("opt-in", false, "shared", "returning");
  const retained = choice(projectNamespace, returning, "include");

  const missing = resolveInitialSelection({
    choices: [retained],
    entries: [],
    namespace: projectNamespace,
  });
  const reintroduced = resolveInitialSelection({
    choices: [retained],
    entries: [returning],
    namespace: projectNamespace,
  });

  expect(missing).toMatchObject({ decisions: [], unresolvedChoices: [retained] });
  expect(reintroduced).toMatchObject({
    decisions: [{ _tag: "selected", compatibility: "forced", reason: "include" }],
    unresolvedChoices: [],
  });
});

it("normalizes permutations of choices and entries", () => {
  const alpha = entry("default", true, "shared", "alpha");
  const beta = entry("default", true, "shared", "beta");
  const missing = choice(projectNamespace, entry("default", true, "shared", "missing"), "include");
  const values = [choice(projectNamespace, beta, "exclude"), missing];
  const forward = resolveInitialSelection({
    choices: values,
    entries: [beta, alpha],
    namespace: projectNamespace,
  });
  const reversed = resolveInitialSelection({
    choices: [...values].reverse(),
    entries: [alpha, beta],
    namespace: projectNamespace,
  });

  expect(reversed).toEqual(forward);
  expect(Schema.encodeSync(InitialSelectionSchema)(forward)).toEqual(forward);
});

it("keeps global defaults independent from project activation", () => {
  const globalDefault = { ...entry("opt-in", true), userActivation: "default" as const };
  const globalOptional = { ...entry("default", true), userActivation: "opt-in" as const };
  const select = (
    catalogEntry: SkillCatalogEntry,
    namespace: ChoiceNamespace,
    choices: ReadonlyArray<SkillChoice> = [],
  ) => resolveInitialSelection({ entries: [catalogEntry], choices, namespace }).decisions[0];

  expect(select(globalDefault, userNamespace)).toMatchObject({
    _tag: "selected",
    reason: "default",
  });
  expect(select(globalDefault, projectNamespace)).toMatchObject({
    _tag: "not-selected",
    reason: "opt-in",
  });
  expect(select(globalOptional, userNamespace)).toMatchObject({
    _tag: "not-selected",
    reason: "opt-in",
  });
  expect(select(globalOptional, projectNamespace)).toMatchObject({
    _tag: "selected",
    reason: "default",
  });
  expect(
    select(globalDefault, userNamespace, [choice(userNamespace, globalDefault, "exclude")]),
  ).toMatchObject({ _tag: "not-selected", reason: "exclude" });
  expect(
    select(globalOptional, userNamespace, [choice(userNamespace, globalOptional, "include")]),
  ).toMatchObject({ _tag: "selected", reason: "include" });
});

const shared = entry("default", true, "shared", "review");
const mine = entry("default", true, "private", "review");

it("lets an explicit include win over a default-activated twin of the same name", () => {
  const resolved = resolveInitialSelection({
    choices: [choice(projectNamespace, mine, "include")],
    entries: [shared, mine],
    namespace: projectNamespace,
  });

  expect(resolved.decisions).toMatchObject([
    { _tag: "not-selected", reason: "superseded", address: shared.address },
    { _tag: "selected", reason: "include", address: mine.address },
  ]);
});

it("keeps both twins selected when both are included, so the collision stays visible", () => {
  const resolved = resolveInitialSelection({
    choices: [
      choice(projectNamespace, shared, "include"),
      choice(projectNamespace, mine, "include"),
    ],
    entries: [shared, mine],
    namespace: projectNamespace,
  });

  expect(resolved.decisions.map(({ _tag }) => _tag)).toEqual(["selected", "selected"]);
});

it("keeps an excluded twin excluded and leaves a different name or namespace alone", () => {
  const other = entry("default", true, "private", "lint");
  const excluded = resolveInitialSelection({
    choices: [
      choice(projectNamespace, mine, "include"),
      choice(projectNamespace, shared, "exclude"),
    ],
    entries: [shared, mine],
    namespace: projectNamespace,
  });
  expect(excluded.decisions).toMatchObject([
    { _tag: "not-selected", reason: "exclude" },
    { _tag: "selected", reason: "include" },
  ]);

  const differentName = resolveInitialSelection({
    choices: [choice(projectNamespace, other, "include")],
    entries: [shared, other],
    namespace: projectNamespace,
  });
  expect(differentName.decisions.map(({ _tag }) => _tag)).toEqual(["selected", "selected"]);

  const otherNamespace = resolveInitialSelection({
    choices: [choice(userNamespace, mine, "include")],
    entries: [shared, mine],
    namespace: projectNamespace,
  });
  expect(otherNamespace.decisions.map(({ _tag }) => _tag)).toEqual(["selected", "selected"]);
});
