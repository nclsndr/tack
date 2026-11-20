import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { emptyState, StateSchema } from "./state-schema.ts";

const source = "21380456-fa78-4ed4-95ae-110da2a6d41c";
const other = "7d3f1c2a-9b4e-4f6a-8c1d-2e5b6a7c8d9e";

const project = (name: string, root = `/work/${name}`) => ({
  gitCommonDirectory: `/work/${name}/.git`,
  name,
  roots: [root],
  removingRoots: [],
});
const withData = (data: Record<string, unknown>, format = 1) => ({
  format,
  data: { ...emptyState().data, ...data },
});
const decode = Schema.decodeUnknownSync(StateSchema);

it("accepts docs settings with one explicit writing default", () => {
  const state = withData({
    projects: [
      {
        ...project("demo"),
        docs: {
          attachments: [
            { sourceRegistrationId: source, name: "guide", writingDefault: true },
            { sourceRegistrationId: source, name: "notes" },
          ],
        },
      },
    ],
  });

  expect(decode(state)).toEqual(state);
});

it.each([
  [
    "attaches the same docs resource twice",
    [
      { sourceRegistrationId: source, name: "guide" },
      { sourceRegistrationId: source, name: "guide" },
    ],
    "Docs attachments must be unique.",
  ],
  [
    "names two writing defaults",
    [
      { sourceRegistrationId: source, name: "guide", writingDefault: true },
      { sourceRegistrationId: source, name: "notes", writingDefault: true },
    ],
    "Docs settings can have at most one explicit writing default.",
  ],
])("refuses docs settings that %s", (_case, attachments, message) => {
  expect(() =>
    decode(withData({ projects: [{ ...project("demo"), docs: { attachments } }] })),
  ).toThrow(message);
});

it("refuses a project whose roots break the project record rules", () => {
  expect(() =>
    decode(withData({ projects: [{ ...project("demo"), roots: ["/work/b", "/work/a"] }] })),
  ).toThrow("Active project roots must use unique canonical code-unit ordering.");
});

it("refuses two projects with the same namespace name", () => {
  expect(() =>
    decode(withData({ projects: [project("demo", "/work/a"), project("demo", "/work/b")] })),
  ).toThrow("Project namespace names must be unique.");
});

it.each([
  ["active roots", project("second", "/work/shared")],
  [
    "an active and a handoff root",
    { ...project("second"), roots: [], removingRoots: ["/work/shared"] },
  ],
])("refuses two projects that share %s", (_case, second) => {
  expect(() => decode(withData({ projects: [project("first", "/work/shared"), second] }))).toThrow(
    "Each canonical project root must have one owner.",
  );
});

it("refuses a namespace that chooses the same resource twice", () => {
  const choice = {
    address: { kind: "skill", name: "guide", sourceRegistrationId: source },
    decision: "include",
  };

  expect(() =>
    decode(withData({ projects: [{ ...project("demo"), choices: [choice, choice] }] })),
  ).toThrow("Resource choices must be unique within each namespace.");
});

it.each([
  [
    "registration identity",
    [
      { id: source, canonicalPath: "/sources/a" },
      { id: source, canonicalPath: "/sources/b" },
    ],
    "Skill-source registration identities must be unique.",
  ],
  [
    "canonical path",
    [
      { id: source, canonicalPath: "/sources/a" },
      { id: other, canonicalPath: "/sources/a" },
    ],
    "Skill-source canonical paths must be unique.",
  ],
])("refuses two sources that share a %s", (_case, sources, message) => {
  expect(() => decode(withData({ sources }))).toThrow(message);
});

it("accepts a bundle-provided source", () => {
  const bundled = {
    id: source,
    canonicalPath: "/sources/a",
    bundle: {
      identity: "a".repeat(64),
      sourceKey: "shared",
      bindings: {},
      sourceKeys: {},
      files: [],
    },
  };

  expect(decode(withData({ sources: [bundled] }))).toMatchObject({ format: 1 });
});

it.each([0, 2, 3])("refuses state format %i: the model holds format 1 only", (format) => {
  expect(() => decode(withData({}, format))).toThrow();
});
