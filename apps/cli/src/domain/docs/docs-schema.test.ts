import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  DocsManagedLinkSchema,
  DocsPendingRemovalsSchema,
  DocsProjectSchema,
  docsLink,
  docsPendingRemovalsOf,
  managedDocsLinksOf,
  reportDocsManagedLink,
  type DocsManagedLink,
} from "./docs-schema.ts";

const source = "21380456-fa78-4ed4-95ae-110da2a6d41c";
const otherSource = "7d3f1c2a-9b4e-4f6a-8c1d-2e5b6a7c8d9e";
const guide = { sourceRegistrationId: source, name: "guide" };
const notes = { sourceRegistrationId: source, name: "notes" };

const mount = (name: string): DocsManagedLink => ({
  projectName: "demo",
  root: "/work/demo",
  resource: { sourceRegistrationId: source, name },
  destinationPath: `/work/demo/.tack/docs/${name}`,
  sourceDirectoryPath: `/sources/docs/${name}`,
});

it("accepts a project whose default writing resource is one of its attachments", () => {
  const project = {
    projectName: "demo",
    attachments: [guide, notes],
    defaultWritingResource: notes,
  };

  expect(Schema.decodeUnknownSync(DocsProjectSchema)(project)).toEqual(project);
});

it("refuses a project that attaches the same docs resource twice", () => {
  expect(() =>
    Schema.decodeUnknownSync(DocsProjectSchema)({
      projectName: "demo",
      attachments: [guide, guide],
    }),
  ).toThrow("Docs attachments must be unique.");
});

it("refuses a default writing resource that is not attached", () => {
  expect(() =>
    Schema.decodeUnknownSync(DocsProjectSchema)({
      projectName: "demo",
      attachments: [guide],
      defaultWritingResource: { ...guide, sourceRegistrationId: otherSource },
    }),
  ).toThrow("The default writing resource must be attached.");
});

it.each(["/work/demo", "/work/other/guide", "/work/demo/../guide"])(
  "refuses docs evidence whose destination %s is not inside its root",
  (destinationPath) => {
    expect(() =>
      Schema.decodeUnknownSync(DocsManagedLinkSchema)({ ...mount("guide"), destinationPath }),
    ).toThrow();
  },
);

it("names the containment rule when docs evidence leaves its root", () => {
  expect(() =>
    Schema.decodeUnknownSync(DocsManagedLinkSchema)({
      ...mount("guide"),
      destinationPath: "/work/other/guide",
    }),
  ).toThrow("Docs evidence must keep its destination inside its root.");
});

it("leaves pending-only docs records out of the managed mounts", () => {
  const managed = docsLink(mount("guide"));
  const pendingOnly = {
    ...docsLink(mount("notes")),
    removal: { cause: "clean" as const },
    pendingOnly: true as const,
  };

  expect(managedDocsLinksOf([managed, pendingOnly])).toEqual([mount("guide")]);
});

it("reports owed docs removals in destination order with their link text", () => {
  const owed = (name: string) => ({
    ...docsLink(mount(name)),
    removal: { cause: "reset" as const },
  });

  const removals = docsPendingRemovalsOf([owed("notes"), docsLink(mount("other")), owed("guide")]);

  expect(removals).toEqual([
    { cause: "reset", evidence: reportDocsManagedLink(mount("guide")) },
    { cause: "reset", evidence: reportDocsManagedLink(mount("notes")) },
  ]);
  expect(removals[0]?.evidence.relativeTarget).toBe("../../../../sources/docs/guide");
  expect(Schema.decodeUnknownSync(DocsPendingRemovalsSchema)(removals)).toEqual(removals);
});

it.each([
  [
    "repeat a destination",
    ["guide", "guide"],
    "Docs pending removals must be unique by destination path.",
  ],
  [
    "are out of destination order",
    ["notes", "guide"],
    "Docs pending removals must use canonical code-unit ordering.",
  ],
])("refuses reported docs removals that %s", (_case, names, message) => {
  const removals = names.map((name) => ({
    cause: "clean",
    evidence: reportDocsManagedLink(mount(name)),
  }));

  expect(() => Schema.decodeUnknownSync(DocsPendingRemovalsSchema)(removals)).toThrow(message);
});
