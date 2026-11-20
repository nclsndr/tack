import { expect, it } from "@effect/vitest";
import { catalogOutcome } from "../src/cli/host/outcomes.ts";

const script = {
  kind: "script",
  address: {
    kind: "script",
    name: "sync",
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  },
  declaredPath: "sync.ts",
  description: "Sync things",
  directoryPath: "/source/scripts",
  filePath: "/source/scripts/sync.ts",
  origin: "registered",
  sourcePath: "/source",
  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
} as const;

it("presents a valid catalog report unchanged", () => {
  const report = { kind: "catalog", complete: true, issues: [], resources: [script] } as const;

  expect(catalogOutcome(report)).toEqual({
    classification: "success",
    diagnostics: [],
    result: report,
  });
});

it("rejects a resource whose kind disagrees with its address instead of repairing it", () => {
  const mismatched = {
    kind: "catalog",
    complete: true,
    issues: [],
    resources: [{ ...script, address: { ...script.address, kind: "skill" } }],
  };

  expect(() => catalogOutcome(mismatched)).toThrow();
});
