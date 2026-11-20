import { expect, it } from "vitest";
import { profileDeliveryCollisions } from "./inventory-collisions.ts";

it("finds competing skill/command deliveries without treating exact duplicates or inspectable kinds as collisions", () => {
  const address = (
    kind: "skill" | "command" | "context" | "docs" | "script",
    sourceRegistrationId: string,
  ) => ({ kind, name: "review", sourceRegistrationId });
  expect(
    profileDeliveryCollisions([
      address("skill", "one"),
      address("skill", "one"),
      address("command", "two"),
    ]),
  ).toEqual([]);
  expect(
    profileDeliveryCollisions([
      address("skill", "one"),
      address("skill", "two"),
      address("command", "one"),
      address("command", "two"),
    ]),
  ).toEqual(["skill:review", "command:review"]);
  expect(
    profileDeliveryCollisions([
      address("context", "one"),
      address("context", "two"),
      address("docs", "one"),
      address("docs", "two"),
      address("script", "one"),
      address("script", "two"),
    ]),
  ).toEqual([]);
});
