import { expect, it } from "vitest";
import { Schema } from "effect";
import { DoctorReportSchema } from "./doctor-schema.ts";

const report = {
  kind: "doctor-report",
  release: { stamp: "dev", sourceRun: true },
  stateDirectory: "/home/me/.local/state/tack",
  summary: { ok: 0, warning: 0, failed: 0, skipped: 0, total: 0 },
  checks: [],
};

it("accepts a summary that counts the report's checks", () => {
  expect(Schema.decodeUnknownSync(DoctorReportSchema)(report)).toEqual(report);
});

it("refuses a summary that does not count the report's checks", () => {
  expect(() =>
    Schema.decodeUnknownSync(DoctorReportSchema)({
      ...report,
      summary: { ...report.summary, ok: 1, total: 1 },
    }),
  ).toThrow("The summary must count the report's checks.");
});
