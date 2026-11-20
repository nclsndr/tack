import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CatalogReportSchema } from "../../../../domain/sources/catalog-report.ts";
import { humanFixture } from "../human.test-support.ts";
import { explorerEntries } from "./entries.ts";

const report = Schema.decodeUnknownSync(CatalogReportSchema)(humanFixture("catalog").result);
const sourceRegistrationId = "0d5b3402-2162-4620-ae41-ddc81538eb23";
const project = { _tag: "project", projectName: "demo" } as const;
const identity = (path: string) => path;

/** The catalog fixture with `review` declaring an optional dependency and living outside its source. */
const changed = {
  ...report,
  resources: report.resources.map((resource) =>
    resource.kind === "skill" && resource.address.name === "review"
      ? {
          ...resource,
          directoryPath: "/elsewhere/review",
          dependencies: [{ kind: "skill" as const, name: "helper", optional: true as const }],
        }
      : resource,
  ),
};
const entries = explorerEntries(
  changed,
  [
    {
      address: { kind: "skill", name: "review", sourceRegistrationId },
      decision: "exclude",
      namespace: project,
    },
  ],
  identity,
  { namespace: project, attachments: [] },
);
const byTitle = (title: string) => entries.find((entry) => entry.title === title);

describe("explorer entries", () => {
  it("offers no edit on a script, which no selection holds", () => {
    expect(byTitle("run")?.editable).toBeUndefined();
    expect(byTitle("review")?.editable).toMatchObject({ kind: "choice", current: "exclude" });
  });

  it("keeps saved picks out of the row tags and marks an optional dependency", () => {
    const review = byTitle("review");
    expect(review?.tags).toEqual([]);
    expect(review?.facts).toContainEqual(["depends on", "skill helper (optional)"]);
  });

  it("lists a resource outside its source without folders", () => {
    expect(byTitle("planner")?.tree).toEqual({ source: "/fx/source", folders: ["skills"] });
    expect(byTitle("review")?.tree).toEqual({ source: "/fx/source", folders: [] });
  });

  it("titles an issue without an address by its candidate file", () => {
    expect(entries.filter((entry) => entry.issue).map((entry) => entry.title)).toEqual([
      `skill ${sourceRegistrationId}:broken`,
      "/fx/source/skills/日本語スキル/SKILL.md",
    ]);
  });
});
