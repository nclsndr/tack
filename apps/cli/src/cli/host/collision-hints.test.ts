import { expect, it } from "vitest";
import { collisionExcludeCommands } from "./collision-hints.ts";
import { styleOf } from "./human/human.test-support.ts";
import { partialCauseDiagnostic } from "./partial-causes.ts";

const team = "11111111-1111-4111-8111-111111111111";
const me = "22222222-2222-4222-8222-222222222222";
const addresses = [
  { kind: "skill", name: "review", sourceRegistrationId: me },
  { kind: "skill", name: "review", sourceRegistrationId: team },
] as const;
const project = { _tag: "project-root", canonicalPath: "/work/demo", projectName: "demo" } as const;
const user = { _tag: "user", canonicalPath: "/home/me" } as const;

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

it("names one exclude command per collision candidate, in the colliding namespace", () => {
  expect(collisionExcludeCommands({ target: project, addresses }, labelled.reference)).toEqual([
    "tack pick exclude me:review --kind skill --project demo",
    "tack pick exclude team:review --kind skill --project demo",
  ]);
  expect(collisionExcludeCommands({ target: user, addresses }, labelled.reference)).toEqual([
    "tack pick exclude me:review --kind skill --user",
    "tack pick exclude team:review --kind skill --user",
  ]);
  expect(
    collisionExcludeCommands(
      { target: { ...project, projectName: "my project" }, addresses },
      labelled.reference,
    )[0],
  ).toBe("tack pick exclude me:review --kind skill --project 'my project'");
});

it("puts the same commands in the cause message, by registration ID so the diagnostic stays stable", () => {
  const { message } = partialCauseDiagnostic({
    code: "selection-collision",
    subject: { adapter: "claude", target: project, addresses, name: "review" },
  });
  expect(message).toBe(
    `Two or more selected resources need the same destination name. Exclude all but one: tack pick exclude ${me}:review --kind skill --project demo or tack pick exclude ${team}:review --kind skill --project demo.`,
  );
  // Every other cause keeps its registry message.
  expect(
    partialCauseDiagnostic({ code: "project-removing", subject: { projectName: "demo" } }).message,
  ).toBe("A project is being removed; its selections are suspended until cleanup ends.");
});
