import { evidenceFor, targetProject, targetUser } from "../../../test/support/state-fixture.ts";
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { RemovalPlanSchema, RemovalScopeSchema } from "./removal-schema.ts";

const demo = targetProject("demo", "/work/demo");

const removal = (name: string, destinationPath = `/work/demo/.agents/skills/${name}`) => ({
  _tag: "remove",
  destinationPath,
  evidence: evidenceFor("codex", demo, `/sources/${name}`, name),
});
const project = (name: string) => ({
  gitCommonDirectory: `/work/${name}/.git`,
  name,
  roots: [`/work/${name}`],
});
const plan = {
  actions: [],
  cause: "clean",
  expectedManagedLinks: [],
  expectedPendingRemovals: [],
  finalizeProject: false,
  kind: "managed-removal-plan",
  scope: { _tag: "maintenance" },
  version: 1,
};

const decode = Schema.decodeUnknownSync(RemovalPlanSchema);

it("accepts ordered removals whose destinations derive from their evidence", () => {
  const ordered = {
    ...plan,
    actions: [removal("guide"), removal("other")],
    expectedProjects: [project("alpha"), project("beta")],
  };

  expect(decode(ordered)).toEqual(ordered);
});

it.each([
  ["out of order", [removal("other"), removal("guide")]],
  ["repeated", [removal("guide"), removal("guide")]],
])("refuses removal actions whose destinations are %s", (_case, actions) => {
  expect(() => decode({ ...plan, actions })).toThrow(
    "Removal actions must use unique code-unit ordered destinations.",
  );
});

it("refuses a removal action whose destination its evidence does not derive", () => {
  expect(() =>
    decode({ ...plan, actions: [removal("guide", "/work/demo/.agents/skills/zzz")] }),
  ).toThrow("Removal actions must derive destinations from their evidence.");
});

it.each([
  ["out of order", [project("beta"), project("alpha")]],
  ["repeated", [project("alpha"), project("alpha")]],
])("refuses expected projects that are %s", (_case, expectedProjects) => {
  expect(() => decode({ ...plan, expectedProjects })).toThrow(
    "Removal projects must use deterministic ordering.",
  );
});

it("accepts selected targets only in canonical order and without repeats", () => {
  const first = targetProject("project", "/repo/a");
  const second = targetUser("/user");
  const scope = { _tag: "selected-targets" as const, targets: [first, second] };
  const decodeScope = Schema.decodeUnknownSync(RemovalScopeSchema);

  expect(decodeScope(scope)).toEqual(scope);
  expect(() => decodeScope({ ...scope, targets: [second, first] })).toThrow();
  expect(() => decodeScope({ ...scope, targets: [first, first] })).toThrow();
});
