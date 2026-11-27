import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import {
  referenceFor,
  resolveResourceReference,
  sourceQualifier,
  type ReferenceIndex,
} from "./resource-reference.ts";
import { generatedSkillRegistrationId } from "../../domain/generated/sources-skill.ts";

const team = "11111111-1111-4111-8111-111111111111";
const me = "22222222-2222-4222-8222-222222222222";
const entry = (sourceRegistrationId: string, kind: string, name: string) => ({
  address: { kind, name, sourceRegistrationId },
  sourceRegistrationId,
});
const source = (id: string, label: string, labelOrigin = "declared") => ({
  registration: { id },
  label,
  labelOrigin,
});

const index: ReferenceIndex = {
  entries: [
    entry(team, "skill", "review"),
    entry(me, "skill", "review"),
    entry(team, "skill", "lint"),
    entry(me, "command", "review"),
  ],
  sources: [source(team, "team"), source(me, "me")],
};

it("names a resource by its bare name only when its kind and name are unique", () => {
  expect(referenceFor(index, { kind: "skill", name: "lint", sourceRegistrationId: team })).toBe(
    "lint",
  );
  expect(referenceFor(index, { kind: "skill", name: "review", sourceRegistrationId: me })).toBe(
    "me:review",
  );
  // The same name of another kind does not make a skill ambiguous.
  expect(referenceFor(index, { kind: "command", name: "review", sourceRegistrationId: me })).toBe(
    "review",
  );
});

it("keeps a qualifier for a resource the catalog no longer holds, and for an unlabelled source", () => {
  const gone = "33333333-3333-4333-8333-333333333333";
  expect(referenceFor(index, { kind: "skill", name: "lint", sourceRegistrationId: gone })).toBe(
    `${gone}:lint`,
  );
  // One resource of that name, but from another source: a bare name would point elsewhere.
  expect(referenceFor(index, { kind: "skill", name: "lint", sourceRegistrationId: me })).toBe(
    "me:lint",
  );
  const clashing = { ...index, sources: [source(team, "team", "clashing"), source(me, "me")] };
  expect(
    referenceFor(clashing, { kind: "skill", name: "review", sourceRegistrationId: team }),
  ).toBe(`${team}:review`);
  expect(sourceQualifier({}, team)).toBe(team);
});

it("names a skill Tack generates by its name, which no catalog holds", () => {
  const generated = {
    kind: "skill",
    name: "tack-sources",
    sourceRegistrationId: generatedSkillRegistrationId,
  };
  expect(referenceFor(index, generated)).toBe("tack-sources");
  expect(sourceQualifier(index, generatedSkillRegistrationId)).toBe("generated");
});

const catalog = {
  entries: [
    entry(team, "skill", "review"),
    entry(me, "skill", "review"),
    entry(team, "skill", "lint"),
  ].map((item) => ({ ...item, address: { ...item.address, kind: "skill" as const } })),
  sources: [source(team, "team"), source(me, "me")],
};

it("keeps the chosen target in every command a failed reference suggests", () => {
  const exit = Effect.runSyncExit(
    resolveResourceReference(
      catalog,
      "review",
      ["skill", "command"],
      "tack pick include",
      "skill",
      ["--project", "demo"],
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(JSON.stringify(exit)).toContain(
    "tack pick include team:review --project demo or tack pick include me:review --project demo",
  );
});

it("suggests a bare command when no flags are given", () => {
  const exit = Effect.runSyncExit(
    resolveResourceReference(catalog, "review", ["skill"], "tack script run"),
  );
  expect(JSON.stringify(exit)).toContain(
    "Use tack script run team:review or tack script run me:review.",
  );
});

it("refuses a source label that several registrations share", () => {
  const shared = { ...catalog, sources: [source(team, "team"), source(me, "team")] };
  const error = Effect.runSync(
    Effect.flip(resolveResourceReference(shared, "team:review", ["skill"], "tack pick include")),
  );
  expect(error).toMatchObject({
    code: "source-label-ambiguous",
    message: "Source label team belongs to several registrations. Use one registration ID.",
    candidates: [team, me],
  });
});

it("resolves a reference qualified with a registration ID or a label to that source", () => {
  expect(
    Effect.runSync(
      resolveResourceReference(catalog, `${me}:review`, ["skill"], "tack pick include"),
    ),
  ).toMatchObject({ sourceRegistrationId: me });
  expect(
    Effect.runSync(
      resolveResourceReference(catalog, "team:review", ["skill"], "tack pick include"),
    ),
  ).toMatchObject({ sourceRegistrationId: team });
});

it("names the kind in each suggestion when the candidates differ in kind", () => {
  const mixed = {
    entries: [
      { address: { kind: "skill" as const, name: "review" }, sourceRegistrationId: me },
      { address: { kind: "command" as const, name: "review" }, sourceRegistrationId: me },
    ],
    sources: [source(me, "me")],
  };
  const error = Effect.runSync(
    Effect.flip(
      resolveResourceReference(mixed, "me:review", ["skill", "command"], "tack pick include"),
    ),
  );
  expect(error).toMatchObject({
    code: "resource-ambiguous",
    message:
      "me:review matches several resources. Use tack pick include me:review --kind skill or tack pick include me:review --kind command.",
  });
});

it("reports a reference that matches nothing", () => {
  const error = Effect.runSync(
    Effect.flip(resolveResourceReference(catalog, "absent", ["skill"], "tack pick include")),
  );
  expect(error).toMatchObject({
    code: "resource-not-found",
    message: "No healthy resource matches absent. Run tack catalog to inspect available resources.",
  });
});
