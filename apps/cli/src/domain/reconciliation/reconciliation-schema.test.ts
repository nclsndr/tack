import { evidenceFor, targetProject } from "../../../test/support/state-fixture.ts";
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { ReconciliationActionSchema } from "./reconciliation-schema.ts";

const demo = targetProject("demo", "/work/demo");

const guideDestination = "/work/demo/.agents/skills/guide";

const decode = Schema.decodeUnknownSync(ReconciliationActionSchema);

it.each(["/sources/guide", "C:\\sources\\guide", "\\\\server\\share"])(
  "refuses the absolute link target %s",
  (relativeTarget) => {
    expect(() =>
      decode({
        _tag: "link-create",
        destinationPath: guideDestination,
        evidence: evidenceFor("codex", demo, "/sources/guide", "guide"),
        relativeTarget,
      }),
    ).toThrow("Managed symbolic-link targets must be relative.");
  },
);

it("refuses a blocked link removal that does not name its blockers", () => {
  expect(() =>
    decode({
      _tag: "link-remove",
      destinationPath: guideDestination,
      evidence: evidenceFor("codex", demo, "/sources/guide", "guide"),
      reason: "blocked",
    }),
  ).toThrow("A blocked link removal must name its blockers, and only a blocked one.");
});
