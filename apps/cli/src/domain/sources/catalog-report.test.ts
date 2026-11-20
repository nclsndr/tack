import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  CatalogReportSchema,
  CatalogResourceSchema,
  catalogReport,
  type CatalogResource,
} from "./catalog-report.ts";
import type { ResourceKind } from "../resources/kinds.ts";
import type { Catalog, CatalogEntry } from "./catalog-schema.ts";

const sourceRegistrationId = "00000000-0000-4000-8000-000000000001";
const source = { sourcePath: "/source", sourceRegistrationId } as const;

const skill = {
  ...source,
  activation: "default",
  address: { kind: "skill", name: "review", sourceRegistrationId },
  dependencies: [],
  description: "Review code",
  directoryPath: "/source/skills/review",
  frontmatter: {
    description: "Review code",
    metadata: { tack: "version: 1\n" },
    name: "review",
    vendor: "kept",
  },
  projects: [],
  skillFilePath: "/source/skills/review/SKILL.md",
} as const satisfies CatalogEntry;
const command = {
  ...source,
  activation: "default",
  address: { kind: "command", name: "ship", sourceRegistrationId },
  dependencies: [],
  directoryPath: "/source/commands",
  filePath: "/source/commands/ship.md",
  frontmatter: { description: "Ship it" },
  projects: [],
} as const satisfies CatalogEntry;
const context = {
  ...source,
  address: { kind: "context", name: "notes.md", sourceRegistrationId },
  directoryPath: "/source/context",
  filePath: "/source/context/notes.md",
} as const satisfies CatalogEntry;
const script = {
  ...source,
  address: { kind: "script", name: "sync", sourceRegistrationId },
  declaredPath: "sync.ts",
  description: "Sync things",
  directoryPath: "/source/private/scripts",
  filePath: "/source/private/scripts/sync.ts",
} as const satisfies CatalogEntry;
const docs = {
  ...source,
  address: { kind: "docs", name: "guide", sourceRegistrationId },
  directoryPath: "/source/docs",
  origin: "builtin",
  readerConfig: { kind: "source", path: "/source/tack.yaml" },
} as const satisfies CatalogEntry;

const catalog = (overrides: Partial<Catalog> = {}): Catalog => ({
  entries: [skill, command, context, script, docs],
  quarantined: [],
  unhealthySources: [],
  ...overrides,
});

const decodeResource = Schema.decodeUnknownSync(CatalogResourceSchema, {
  onExcessProperty: "error",
});
const decodeReport = Schema.decodeUnknownSync(CatalogReportSchema, { onExcessProperty: "error" });
const kinds: ReadonlyArray<ResourceKind> = ["skill", "command", "context", "script", "docs"];

describe("catalog resources", () => {
  it("carries the same kind on every resource and in its address", () => {
    const report = catalogReport(catalog(), { details: true });

    expect(report.resources.map((resource) => [resource.kind, resource.address.kind])).toEqual(
      kinds.map((kind) => [kind, kind]),
    );
    expect(decodeReport(report)).toEqual(report);
  });

  it.each(
    kinds.flatMap((kind) => kinds.filter((other) => other !== kind).map((other) => [kind, other])),
  )("rejects a %s resource whose address names a %s", (kind, addressKind) => {
    const resource = catalogReport(catalog()).resources.find(
      (candidate) => candidate.kind === kind,
    );
    const mismatched = { ...resource, address: { ...resource?.address, kind: addressKind } };

    expect(() => decodeResource(mismatched)).toThrow();
    expect(() => decodeReport({ ...catalogReport(catalog()), resources: [mismatched] })).toThrow();
  });

  it("dispatches on the resource kind without inspecting its address", () => {
    const kindFact = (resource: CatalogResource): string => {
      if (resource.kind === "skill" || resource.kind === "command") return resource.activation;
      if (resource.kind === "script") return resource.declaredPath;
      if (resource.kind === "context") return resource.filePath;
      return resource.readerConfig.path;
    };

    expect(catalogReport(catalog()).resources.map(kindFact)).toEqual([
      "default",
      "default",
      "/source/context/notes.md",
      "sync.ts",
      "/source/tack.yaml",
    ]);
  });

  it("states the origin of every resource and uses filePath for skill documents", () => {
    const [skillResource, , , , docsResource] = catalogReport(catalog()).resources;

    expect(skillResource).toMatchObject({
      filePath: "/source/skills/review/SKILL.md",
      origin: "registered",
    });
    expect(skillResource).not.toHaveProperty("skillFilePath");
    expect(docsResource).toMatchObject({ origin: "builtin" });
  });

  it("omits frontmatter by default and keeps one normalized description", () => {
    const [skillResource, commandResource] = catalogReport(catalog()).resources;

    expect(skillResource).toEqual({
      kind: "skill",
      activation: "default",
      address: skill.address,
      dependencies: [],
      description: "Review code",
      directoryPath: "/source/skills/review",
      filePath: "/source/skills/review/SKILL.md",
      origin: "registered",
      projects: [],
      sourcePath: "/source",
      sourceRegistrationId,
    });
    expect(commandResource).toMatchObject({ description: "Ship it" });
    expect(commandResource).not.toHaveProperty("frontmatter");
  });

  it("returns the complete authored frontmatter with details", () => {
    const [skillResource, commandResource] = catalogReport(catalog(), { details: true }).resources;

    expect(skillResource).toMatchObject({ frontmatter: skill.frontmatter });
    expect(commandResource).toMatchObject({ frontmatter: command.frontmatter });
  });

  it("leaves a command description absent unless its frontmatter declares a usable one", () => {
    const resources = catalogReport(
      catalog({
        entries: [
          { ...command, frontmatter: {} },
          {
            ...command,
            address: { ...command.address, name: "blank" },
            frontmatter: { description: " " },
          },
          {
            ...command,
            address: { ...command.address, name: "number" },
            frontmatter: { description: 1 },
          },
        ],
      }),
    ).resources;

    expect(resources.map((resource) => "description" in resource)).toEqual([false, false, false]);
  });
});

describe("catalog issues and completeness", () => {
  const quarantinedSkill = {
    candidateKind: "skill",
    code: "skill-name-mismatch",
    directoryPath: "/source/skills/Broken",
    message: "The skill name must match its directory.",
    skillFilePath: "/source/skills/Broken/SKILL.md",
    sourcePath: "/source",
    sourceRegistrationId,
  } as const;
  const unknownArea = {
    code: "resource-unreadable",
    directoryPath: "/source/private",
    message: "The personal area must be a directory.",
    sourcePath: "/source",
    sourceRegistrationId,
  } as const;
  const unhealthySource = {
    issue: { code: "source-missing", message: "The source directory is missing." },
    registration: { canonicalPath: "/gone", id: "00000000-0000-4000-8000-000000000002" },
    status: "unhealthy",
  } as const;

  it("names each problem's subject without inventing an address", () => {
    const report = catalogReport(
      catalog({ quarantined: [quarantinedSkill], unhealthySources: [unhealthySource] }),
    );

    expect(report.complete).toBe(false);
    expect(report.issues).toEqual([
      {
        code: "source-missing",
        message: "The source directory is missing.",
        subject: {
          _tag: "source",
          origin: "registered",
          sourcePath: "/gone",
          sourceRegistrationId: "00000000-0000-4000-8000-000000000002",
        },
      },
      {
        code: "skill-name-mismatch",
        message: "The skill name must match its directory.",
        subject: {
          _tag: "resource",
          candidateKind: "skill",
          candidatePath: "/source/skills/Broken/SKILL.md",
          sourcePath: "/source",
          sourceRegistrationId,
        },
      },
    ]);
    expect(decodeReport(report)).toEqual(report);
  });

  it("distinguishes an empty complete catalog from an empty incomplete one", () => {
    const empty = catalogReport(catalog({ entries: [] }));
    const unavailable = catalogReport(
      catalog({ entries: [], unhealthySources: [unhealthySource] }),
    );

    expect(empty).toEqual({
      kind: "catalog",
      complete: true,
      issues: [],
      sources: [],
      resources: [],
    });
    expect(unavailable).toMatchObject({ complete: false, resources: [] });
    expect(unavailable.issues).toHaveLength(1);
  });

  it("rejects a report whose completeness disagrees with its issues", () => {
    expect(() => decodeReport({ ...catalogReport(catalog()), complete: false })).toThrow();
  });

  it("scopes scripts: known non-script problems drop out, uncertain coverage stays", () => {
    const scoped = catalogReport(
      catalog({
        quarantined: [quarantinedSkill, unknownArea],
        unhealthySources: [unhealthySource],
      }),
      { scope: "script" },
    );
    const skillOnly = catalogReport(catalog({ quarantined: [quarantinedSkill] }), {
      scope: "script",
    });

    expect(scoped.resources.map((resource) => resource.kind)).toEqual(["script"]);
    expect(scoped.issues.map((issue) => issue.subject._tag)).toEqual(["source", "resource"]);
    expect(scoped.issues[1]?.subject).not.toHaveProperty("candidateKind");
    expect(skillOnly).toMatchObject({ complete: true, issues: [], scope: "script" });
    expect(() =>
      decodeReport({ ...skillOnly, resources: catalogReport(catalog()).resources }),
    ).toThrow();
  });
});
