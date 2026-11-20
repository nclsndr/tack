import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { ProjectRecordSchema, ReportedProjectRecordSchema } from "./project-schema.ts";

const active = { gitCommonDirectory: "/work/demo/.git", name: "demo", roots: ["/work/demo"] };
const removing = {
  gitCommonDirectory: "/work/demo/.git",
  name: "demo",
  removalIntent: "project",
  removingRoots: ["/work/demo"],
  roots: [],
};

it("refuses a project that keeps neither active nor handoff roots", () => {
  expect(() => Schema.decodeUnknownSync(ProjectRecordSchema)({ ...active, roots: [] })).toThrow(
    "Removing projects must retain only non-empty handoff roots.",
  );
});

it("refuses a present handoff-root collection that is empty", () => {
  expect(() =>
    Schema.decodeUnknownSync(ProjectRecordSchema)({ ...active, removingRoots: [] }),
  ).toThrow("Present handoff-root collections must not be empty.");
});

it("refuses handoff roots out of canonical order", () => {
  expect(() =>
    Schema.decodeUnknownSync(ProjectRecordSchema)({
      ...removing,
      removingRoots: ["/work/b", "/work/a"],
    }),
  ).toThrow("Handoff project roots must use unique canonical code-unit ordering.");
});

it("refuses a root that is both active and handed off", () => {
  expect(() =>
    Schema.decodeUnknownSync(ProjectRecordSchema)({ ...active, removingRoots: ["/work/demo"] }),
  ).toThrow("A project cannot repeat an active or handoff root.");
});

it.each([
  ["an active project as active", active, "active"],
  ["a removing project as removing", removing, "removing"],
] as const)("reports %s", (_case, project, lifecycle) => {
  const reported = { ...project, lifecycle };

  expect(Schema.decodeUnknownSync(ReportedProjectRecordSchema)(reported)).toEqual(reported);
});

it.each([
  ["an active project as removing", active, "removing"],
  ["a removing project as active", removing, "active"],
] as const)("refuses to report %s", (_case, project, lifecycle) => {
  expect(() =>
    Schema.decodeUnknownSync(ReportedProjectRecordSchema)({ ...project, lifecycle }),
  ).toThrow("Reported project lifecycle must derive from active roots.");
});

it("refuses a reported project whose roots are invalid", () => {
  expect(() =>
    Schema.decodeUnknownSync(ReportedProjectRecordSchema)({
      ...active,
      roots: ["/work/b", "/work/a"],
    }),
  ).toThrow("Reported projects need valid roots.");
});
