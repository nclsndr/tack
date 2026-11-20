import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { SkillCatalogEntrySchema } from "../sources/catalog-schema.ts";
import {
  ManagedLinkEvidenceCollectionSchema,
  ManagedLinkEvidenceSchema,
} from "./managed-link-schema.ts";

const source = "21380456-fa78-4ed4-95ae-110da2a6d41c";
const other = "7d3f1c2a-9b4e-4f6a-8c1d-2e5b6a7c8d9e";

const evidence = {
  adapter: "codex",
  address: { kind: "skill", name: "guide", sourceRegistrationId: source },
  sourceDirectoryPath: "/sources/guide",
  sourceRegistrationId: source,
  target: { _tag: "project-root", projectName: "demo", canonicalPath: "/work/demo" },
};

it("refuses evidence whose address and registration name different sources", () => {
  const decode = Schema.decodeUnknownSync(ManagedLinkEvidenceSchema);
  expect(() => decode(evidence)).not.toThrow();
  expect(() => decode({ ...evidence, sourceRegistrationId: other })).toThrow(
    "one source for its address and its registration",
  );
  expect(() => decode({ ...evidence, address: { kind: "skill", name: "guide" } })).toThrow();
});

it("refuses two evidence records for one physical destination, across namespaces too", () => {
  const decode = Schema.decodeUnknownSync(ManagedLinkEvidenceCollectionSchema);
  const user = { ...evidence, target: { _tag: "user", canonicalPath: "/work/demo" } };

  expect(() => decode([evidence, evidence])).toThrow(
    "Managed-link evidence must be unique by physical destination.",
  );
  expect(() => decode([evidence, user])).toThrow(
    "Managed-link evidence must be unique by physical destination.",
  );
});

it("refuses a catalog entry whose address and registration name different sources", () => {
  const entry = {
    activation: "default",
    address: { kind: "skill", name: "guide", sourceRegistrationId: source },
    dependencies: [],
    description: "Guide",
    directoryPath: "/sources/guide",
    frontmatter: {},
    projects: [],
    skillFilePath: "/sources/guide/SKILL.md",
    sourcePath: "/sources",
    sourceRegistrationId: source,
  };
  const decode = Schema.decodeUnknownSync(SkillCatalogEntrySchema);
  expect(() => decode(entry)).not.toThrow();
  expect(() => decode({ ...entry, sourceRegistrationId: other })).toThrow(
    "address and registration must name the same source",
  );
});
