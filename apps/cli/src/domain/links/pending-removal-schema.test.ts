import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  ReportedPendingRemovalCollectionSchema,
  reportPendingRemoval,
  strongerPendingRemovalCause,
} from "./pending-removal-schema.ts";

const source = "21380456-fa78-4ed4-95ae-110da2a6d41c";

const pending = (name: string) =>
  reportPendingRemoval({
    cause: "clean",
    evidence: {
      adapter: "codex",
      address: { kind: "skill", name, sourceRegistrationId: source },
      sourceDirectoryPath: `/sources/${name}`,
      sourceRegistrationId: source,
      target: { _tag: "project-root", projectName: "demo", canonicalPath: "/work/demo" },
    },
  });

const decode = Schema.decodeUnknownSync(ReportedPendingRemovalCollectionSchema);

it("accepts reported pending removals in destination order", () => {
  const ordered = [pending("alpha"), pending("beta")];

  expect(decode(ordered)).toEqual(ordered);
  expect(ordered.map((item) => item.destinationPath)).toEqual([
    "/work/demo/.agents/skills/alpha",
    "/work/demo/.agents/skills/beta",
  ]);
});

it("refuses reported pending removals that repeat a destination", () => {
  expect(() => decode([pending("alpha"), pending("alpha")])).toThrow(
    "Pending removals must be unique by destination path.",
  );
});

it("refuses reported pending removals out of destination order", () => {
  expect(() => decode([pending("beta"), pending("alpha")])).toThrow(
    "Pending removals must use canonical code-unit ordering.",
  );
});

it("keeps the stronger cleanup cause whichever side it arrives on", () => {
  expect(strongerPendingRemovalCause("clean", "project-removal")).toBe("project-removal");
  expect(strongerPendingRemovalCause("project-removal", "clean")).toBe("project-removal");
  expect(strongerPendingRemovalCause("reset", "adapter-disable")).toBe("adapter-disable");
  expect(strongerPendingRemovalCause("root-removal", "reset")).toBe("root-removal");
});
