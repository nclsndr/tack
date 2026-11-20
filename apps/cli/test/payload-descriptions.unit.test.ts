import { expect, it } from "@effect/vitest";
import { readContracts } from "./support/contracts.ts";

const descriptionsOf = (schema: unknown): ReadonlyArray<string> => {
  if (Array.isArray(schema)) return schema.flatMap(descriptionsOf);
  if (typeof schema !== "object" || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) =>
    key === "description" && typeof value === "string" ? [value] : descriptionsOf(value),
  );
};

it("says what the values of each stable payload mean", async () => {
  const { payloads } = await readContracts();
  const status = descriptionsOf(payloads["skill-status"]);
  // The one wrong guess agents made: `expected-absent` reads as fine, and it is the missing link.
  expect(status.find((text) => text.includes("a link is expected here and is absent"))).toContain(
    "Not healthy",
  );
  expect(status.filter((text) => text.startsWith("Not healthy"))).toHaveLength(8);
  expect(status.some((text) => text.startsWith("Healthy"))).toBe(true);
  expect(status.some((text) => text.includes("says nothing about the link itself"))).toBe(true);
  expect(descriptionsOf(payloads["doctor-report"]).length).toBeGreaterThanOrEqual(3);
  for (const kind of ["sync-plan", "sync-application", "upgrade-guide"])
    expect(descriptionsOf(payloads[kind]).length, kind).toBeGreaterThanOrEqual(1);
});
