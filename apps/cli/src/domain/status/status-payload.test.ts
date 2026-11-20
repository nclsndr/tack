import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { StatusPayloadSchema, StatusReportSchema, statusPayload } from "./status-schema.ts";

/** Complete status reports, as `doctor` reads them, from before the payload was trimmed. */
const fixture = (name: string) =>
  Schema.decodeUnknownSync(StatusReportSchema)(
    JSON.parse(
      readFileSync(
        new URL(`../../../test/fixtures/status-report-${name}.json`, import.meta.url),
        "utf8",
      ),
    ),
  );

it("publishes a payload that decodes with its own schema", () => {
  for (const name of ["before", "trouble", "after"]) {
    const payload = statusPayload(fixture(name));
    expect(
      Schema.decodeUnknownSync(StatusPayloadSchema, { onExcessProperty: "error" })(payload),
    ).toEqual(payload);
  }
});

it("counts the catalog instead of copying it", () => {
  const report = fixture("trouble");
  const payload = statusPayload(report);
  expect(payload.catalog).toEqual({
    quarantined: report.catalog.issues.filter(({ subject }) => subject._tag === "resource").length,
    resources: report.catalog.resources.length,
    unavailable: report.catalog.issues.filter(({ subject }) => subject._tag !== "resource").length,
  });
});

it("names each destination's resource once and drops the repeated evidence", () => {
  const report = fixture("trouble");
  const payload = statusPayload(report);
  expect(payload.destinations).toHaveLength(report.destinations.length);
  for (const [index, destination] of payload.destinations.entries()) {
    const source = report.destinations[index];
    expect(destination._tag).toBe(source?._tag);
    expect(destination.destinationPath).toBe(source?.destinationPath);
    expect(destination.address).toEqual((source?.desired[0] ?? source?.evidence)?.address);
    expect("desired" in destination).toBe(false);
    expect("evidence" in destination).toBe(false);
    // A matching link is exactly what was expected: observing it adds nothing.
    expect("observed" in destination).toBe(destination._tag !== "matching");
  }
});

it("keeps what was observed at a destination that needs attention, without its path", () => {
  const drifted = statusPayload(fixture("trouble")).destinations.find(
    ({ _tag }) => _tag === "drift",
  );
  expect(drifted?.observed).toBeDefined();
  expect(JSON.stringify(drifted?.observed)).not.toContain(drifted?.destinationPath);
});

it("shrinks the parts that grow with the install: destinations and the catalog", () => {
  for (const name of ["before", "trouble", "after"]) {
    const report = fixture(name);
    const payload = statusPayload(report);
    expect(JSON.stringify(payload.destinations).length * 1.5).toBeLessThan(
      JSON.stringify(report.destinations).length,
    );
    expect(JSON.stringify(payload.catalog).length * 20).toBeLessThan(
      JSON.stringify(report.catalog).length,
    );
  }
});
