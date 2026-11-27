import { expect, it } from "vitest";
import { Schema } from "effect";
import { ProfileApplicationSchema } from "./profile-application-schema.ts";
import { StateSchema, emptyState } from "./state-schema.ts";

const address = {
  kind: "skill",
  name: "review",
  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
} as const;
const application = {
  namespace: { _tag: "user" },
  profileName: "ci",
  sourceRegistrationId: address.sourceRegistrationId,
  direct: [address],
  inventory: [address],
  targets: ["/home/ci"],
} as const;
it("retains profile intent in state", () => {
  expect(
    Schema.is(StateSchema)({
      ...emptyState(),
      format: 1,
      data: { ...emptyState().data, profileApplications: [application] },
    }),
  ).toBe(true);
});
it.each([
  ["direct member outside inventory", { ...application, inventory: [] }],
  ["repeated root", { ...application, targets: ["/home/ci", "/home/ci"] }],
])("refuses %s", (_name, input) => expect(Schema.is(ProfileApplicationSchema)(input)).toBe(false));
it("refuses two retained applications for the same context", () =>
  expect(
    Schema.is(StateSchema)({
      ...emptyState(),
      format: 1,
      data: { ...emptyState().data, profileApplications: [application, application] },
    }),
  ).toBe(false));
it("refuses retained inventory that repeats a resource", () => {
  expect(() =>
    Schema.decodeUnknownSync(ProfileApplicationSchema)({
      ...application,
      inventory: [address, address],
    }),
  ).toThrow("Retained inventory must be unique.");
});
