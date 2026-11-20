import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readFileSync, writeFileSync } from "node:fs";
import { outcomeForError } from "../errors.ts";
import {
  envelopeOf,
  expectViewContract,
  flat,
  hintRecorder,
  renderView,
  styleOf,
  testHome,
} from "./human.test-support.ts";
import { importViews } from "./import-views.ts";
import { ImportError } from "../../../features/imports/import-error.ts";
import type {
  ImportApplication,
  ImportCandidate,
  ImportList,
  ImportPlan,
  ImportReach,
  ImportRemovalApplication,
  ImportRemovalPlan,
  ImportState,
  ImportSummary,
} from "../../../domain/imports/import-schema.ts";
import { ImportFetchError } from "../../../services/import-remote.ts";
import { toJson } from "../outcomes.ts";
import { createPublicEnvelope, type PublicEnvelope } from "../public-outcome.ts";
import { parseHintsIn } from "../../../../test/support/hints.ts";

const terminal = { homeDirectory: testHome, views: importViews } as const;
const render = (envelope: PublicEnvelope, width = 80) =>
  renderView(envelope, { ...terminal, width });

const revision = "1a2c79d4e6c4f0e1a2b3c4d5e6f708192a3b4c5d";
const ref = { kind: "default", tracking: true } as const;

const candidate = (
  overrides: Partial<ImportCandidate> & { readonly name: string },
): ImportCandidate => ({
  folder: `skills/${overrides.name}`,
  place: "skills",
  hidden: false,
  verdict: { importable: true },
  files: 12,
  bytes: 84_000,
  executables: 0,
  nonText: 0,
  symlinks: 0,
  submodules: 0,
  nestedSkills: [],
  ...overrides,
});

const pdf = candidate({ name: "pdf", description: "Read, merge and fill in PDF files" });
const docx = candidate({
  name: "docx",
  description: "Create and edit Word documents",
  files: 9,
  bytes: 61_000,
  executables: 1,
});
const broken = candidate({
  name: "x-deck",
  verdict: {
    importable: false,
    code: "skill-frontmatter-schema-invalid",
    message: "name must use lowercase letters, digits and single hyphens",
  },
});

const destination = {
  source: "team-notes",
  registrationId: "00000000-0000-4000-8000-000000000001",
  root: "/home/me/notes",
  folder: "skills",
  declaredFolder: "skills",
  newFolders: [],
} as const;

const reach: ImportReach = {
  name: "pdf",
  projects: [
    { project: "atlas", receives: true },
    { project: "blog", receives: false, reason: "pick exclude" },
    { project: "demo", receives: true },
    { project: "tack", receives: true },
  ],
  user: { receives: false, reason: "user activation is opt-in" },
  collisions: [],
  undeclaredDependencies: [],
};

const basePlan: ImportPlan = {
  kind: "import-plan",
  location: "github:anthropics/skills",
  provider: "github",
  transport: "https",
  ref,
  revision,
  candidates: [docx, pdf, broken],
  hiddenInternal: 0,
  selected: ["pdf"],
  destination,
  writes: [
    { name: "pdf", path: "skills/pdf", upstreamPath: "skills/pdf", files: 12, bytes: 84_000 },
  ],
  reach: [reach],
  outcome: "ready",
};

/** The plan the preview prints when `--into` was not given. */
const omitDestination = (plan: ImportPlan): ImportPlan => {
  const { destination: _destination, ...rest } = plan;
  return rest;
};
const withoutDestination = (
  plan: ImportPlan,
  destinations: NonNullable<ImportPlan["destinations"]>,
): ImportPlan => ({ ...omitDestination(plan), destinations });

const preview = (plan: ImportPlan, diagnostics: PublicEnvelope["diagnostics"] = []) =>
  createPublicEnvelope("import add", {
    classification: "success",
    diagnostics,
    plan: toJson(plan),
  });

const application: ImportApplication = {
  kind: "import-application",
  location: "github:anthropics/skills",
  ref,
  revision,
  destination,
  imported: [
    basePlan.writes[0] ?? {
      name: "pdf",
      path: "skills/pdf",
      upstreamPath: "",
      files: 12,
      bytes: 84_000,
    },
  ],
  rejected: [],
  written: ["skills/pdf/", "tack.yaml"],
  recovered: [],
};

const applied = (value: ImportApplication, plan: ImportPlan = basePlan) =>
  createPublicEnvelope("import add", {
    classification: "success",
    diagnostics: [],
    plan: toJson(plan),
    applied: toJson(value),
  });

const unchanged: ImportState = {
  state: "unchanged",
  added: [],
  removed: [],
  changed: [],
  executable: [],
  special: [],
};
const changedState: ImportState = {
  ...unchanged,
  state: "changed",
  changed: ["SKILL.md"],
  added: ["notes.md"],
  removed: ["scripts/old.py"],
};
const missingState: ImportState = { ...unchanged, state: "missing" };

const summary = (overrides: Partial<ImportSummary> = {}): ImportSummary => ({
  reference: "team-notes:pdf",
  name: "pdf",
  source: "team-notes",
  registrationId: destination.registrationId,
  path: "skills/pdf",
  location: "github:anthropics/skills",
  transport: "https",
  ref,
  revision,
  upstreamPath: "skills/pdf",
  importedAt: "2026-11-11T12:40:00Z",
  local: unchanged,
  conditions: [],
  ...overrides,
});

const listed = (list: Omit<ImportList, "kind">) =>
  createPublicEnvelope("import", {
    classification: "success",
    diagnostics: [],
    result: toJson({ kind: "import-list", ...list }),
  });

const removalPlan: ImportRemovalPlan = {
  kind: "import-removal-plan",
  reference: "team-notes:pdf",
  source: "team-notes",
  registrationId: destination.registrationId,
  name: "pdf",
  path: "skills/pdf",
  location: "github:anthropics/skills",
  revision,
  folderPresent: true,
  files: 12,
  local: unchanged,
  delivered: ["project atlas", "project demo", "project tack"],
  picks: [{ namespace: "project demo", address: "include pdf" }],
  force: false,
};

const removalPreview = (plan: ImportRemovalPlan) =>
  createPublicEnvelope("import remove", {
    classification: "success",
    diagnostics: [],
    plan: toJson(plan),
  });

const failed = (command: string, error: ImportError | ImportFetchError) =>
  createPublicEnvelope(command, outcomeForError(error));

const cases: ReadonlyArray<readonly [string, PublicEnvelope]> = [
  ["preview", preview(basePlan)],
  [
    "preview-rich",
    preview({
      ...basePlan,
      candidates: [
        candidate({
          name: "creator",
          description: "Scaffold skills and their templates for coding agents",
          executables: 2,
          nonText: 1,
          symlinks: 1,
          submodules: 1,
          nestedSkills: ["templates/example"],
          upstreamTack: {
            activation: "default",
            userActivation: "default",
            projects: ["demo"],
            dependencies: [{ kind: "skill", name: "helper", source: "acme" }],
          },
        }),
        pdf,
        broken,
      ],
      hiddenInternal: 2,
      selected: ["creator", "pdf"],
      destination: {
        ...destination,
        folder: "vendor/skills/anthropic",
        declaredFolder: "vendor/skills",
        newFolders: ["vendor/skills/anthropic"],
      },
      split: {
        ref: "main",
        scope: "skills",
        explicit: "github:anthropics/skills/skills#main",
      },
      ref: { kind: "branch", request: "main", tracking: true },
      writes: [
        {
          name: "creator",
          path: "vendor/skills/anthropic/creator",
          upstreamPath: "skills/creator-kit",
          files: 7,
          bytes: 5_300_000,
        },
        {
          name: "pdf",
          path: "vendor/skills/anthropic/pdf",
          upstreamPath: "skills/pdf",
          files: 12,
          bytes: 800,
        },
      ],
      reach: [
        {
          ...reach,
          name: "creator",
          user: { receives: true, reason: "selected by default" },
          collisions: [{ namespace: "project demo", with: "acme:creator" }],
          undeclaredDependencies: ["acme:helper"],
        },
        { ...reach, projects: [] },
      ],
    }),
  ],
  [
    "preview-needs-selection",
    preview(
      withoutDestination(
        { ...basePlan, selected: [], writes: [], reach: [], outcome: "needs-selection" },
        [
          {
            name: "team-notes",
            registrationId: destination.registrationId,
            folders: ["skills"],
          },
          {
            name: "acme",
            registrationId: "00000000-0000-4000-8000-000000000002",
            folders: ["skills", "vendor/skills"],
          },
          { name: "bare", registrationId: "00000000-0000-4000-8000-000000000003", folders: [] },
        ],
      ),
      [
        {
          code: "import-selection-required",
          message:
            "Several skills can be imported. Choose with --skill NAME (repeatable) or --all.",
          severity: "info",
        },
        {
          code: "import-destination-required",
          message: "--apply needs --into SOURCE[:FOLDER], the source that receives the skills.",
          severity: "info",
        },
      ],
    ),
  ],
  [
    "preview-needs-destination",
    preview(
      withoutDestination({ ...basePlan, writes: [], reach: [], outcome: "needs-destination" }, [
        { name: "team-notes", registrationId: destination.registrationId, folders: ["skills"] },
      ]),
    ),
  ],
  [
    "preview-no-sources",
    preview(
      withoutDestination(
        { ...basePlan, selected: [], writes: [], reach: [], outcome: "needs-selection" },
        [],
      ),
    ),
  ],
  [
    "preview-refused",
    preview(
      {
        ...omitDestination(basePlan),
        selected: [],
        writes: [],
        reach: [],
        outcome: "refused",
        refusal: {
          code: "import-destination-invalid",
          message:
            "The source team-notes declares no skills folder, so nothing can be imported into it. Tack never edits a declaration. Add one by hand to its tack.yaml, for example skills: [{ path: skills }], then repeat the command.",
        },
      },
      [
        {
          code: "import-destination-invalid",
          message:
            "The source team-notes declares no skills folder, so nothing can be imported into it. Tack never edits a declaration. Add one by hand to its tack.yaml, for example skills: [{ path: skills }], then repeat the command.",
          severity: "warning",
        },
      ],
    ),
  ],
  [
    "preview-nothing-importable",
    preview(
      {
        ...basePlan,
        candidates: [broken],
        selected: [],
        writes: [],
        reach: [],
        outcome: "nothing-importable",
      },
      [
        {
          code: "import-nothing-importable",
          message: "Nothing in this location can be imported.",
          severity: "info",
        },
      ],
    ),
  ],
  [
    "preview-empty",
    preview({
      ...basePlan,
      candidates: [],
      selected: [],
      writes: [],
      reach: [],
      outcome: "nothing-importable",
    }),
  ],
  [
    "preview-url",
    preview({
      ...basePlan,
      location: "github:anthropics/skills/skills#main",
      urlForm: "https",
      ref: { kind: "branch", request: "main", tracking: true },
      split: { ref: "main", scope: "skills", explicit: "github:anthropics/skills/skills#main" },
    }),
  ],
  ["apply", applied(application)],
  [
    "apply-rich",
    applied({
      ...application,
      destination: {
        ...destination,
        folder: "vendor/skills/anthropic",
        declaredFolder: "vendor/skills",
        newFolders: ["vendor/skills/anthropic"],
      },
      imported: [
        {
          name: "pdf",
          path: "vendor/skills/anthropic/pdf",
          upstreamPath: "skills/pdf",
          files: 12,
          bytes: 800,
        },
        {
          name: "docx",
          path: "vendor/skills/anthropic/docx",
          upstreamPath: "skills/docx",
          files: 1,
          bytes: 10,
        },
      ],
      rejected: [
        {
          name: "x-deck",
          folder: "skills/x-deck",
          code: "skill-frontmatter-schema-invalid",
          message: "name must use lowercase letters, digits and single hyphens",
        },
      ],
      recovered: ["Rolled back the interrupted import of skills/old."],
      ref: { kind: "tag", request: "v1.4.0", tracking: false },
    }),
  ],
  ["list-empty", listed({ imports: [], problems: [] })],
  [
    "list",
    listed({
      imports: [
        summary(),
        summary({
          reference: "team-notes:docx",
          name: "docx",
          path: "skills/docx",
          ref: { kind: "branch", request: "main", tracking: true },
          local: changedState,
          conditions: [{ code: "import-locally-changed", message: "SKILL.md changed" }],
        }),
        summary({
          reference: "acme:web",
          name: "web",
          source: "acme",
          path: "vendor/skills/web",
          ref: { kind: "commit", request: revision, tracking: false },
          local: missingState,
          conditions: [
            {
              code: "import-folder-missing",
              message:
                "vendor/skills/web is gone. Move it back, or run `tack import remove acme:web --apply` to drop the record.",
            },
            {
              code: "import-folder-not-cataloged",
              message: "vendor/skills/web is not in the catalog.",
            },
          ],
        }),
      ],
      problems: [
        {
          source: "acme",
          registrationId: "00000000-0000-4000-8000-000000000002",
          code: "staging-left-over",
          message:
            "/home/me/acme/.tack-import-staging holds an interrupted import write. The next `tack import add --into acme --apply` finishes or rolls it back.",
        },
        {
          source: "bare",
          registrationId: "00000000-0000-4000-8000-000000000003",
          code: "imports-invalid",
          message:
            "The imports section of /home/me/bare/tack.yaml (line 12): flow style is not supported.",
        },
      ],
    }),
  ],
  ["remove-preview", removalPreview(removalPlan)],
  [
    "remove-preview-force",
    removalPreview({
      ...removalPlan,
      force: true,
      local: changedState,
      delivered: [],
      picks: [],
    }),
  ],
  [
    "remove-preview-gone",
    removalPreview({ ...removalPlan, folderPresent: false, local: missingState }),
  ],
  [
    "remove-apply",
    createPublicEnvelope("import remove", {
      classification: "success",
      diagnostics: [],
      plan: toJson(removalPlan),
      applied: toJson({
        kind: "import-removal-application",
        reference: "team-notes:pdf",
        removed: ["skills/pdf/", "tack.yaml"],
        recovered: ["Finished the interrupted removal of skills/old."],
      } satisfies ImportRemovalApplication),
    }),
  ],
  [
    "remove-apply-recovered-only",
    createPublicEnvelope("import remove", {
      classification: "success",
      diagnostics: [],
      applied: toJson({
        kind: "import-removal-application",
        reference: "team-notes:pdf",
        removed: ["tack.yaml"],
        recovered: ["Finished the interrupted removal of skills/pdf."],
      } satisfies ImportRemovalApplication),
    }),
  ],
  [
    "failure-unknown-skill",
    failed(
      "import add",
      new ImportError({
        code: "import-selection-unknown",
        message: 'The location has no skill named "pdff". Skills found: docx, pdf.',
      }),
    ),
  ],
  [
    "failure-removal-blocked",
    failed(
      "import remove",
      new ImportError({
        code: "import-removal-blocked",
        message:
          "skills/pdf has local changes (SKILL.md changed). Removing it deletes them and Tack keeps no copy. Repeat with --force to see the full list and delete it anyway.",
      }),
    ),
  ],
  [
    "failure-not-found",
    failed(
      "import remove",
      new ImportError({
        code: "import-not-found",
        message:
          'No imported skill matches "nope". Nothing has been imported; `tack import` lists imported skills.',
      }),
    ),
  ],
  [
    "failure-network",
    failed(
      "import add",
      new ImportFetchError({
        code: "import-network-failed",
        message:
          "Git could not reach the remote. Check the network connection and try again; nothing was changed.",
      }),
    ),
  ],
  [
    "failure-provider-missing",
    failed(
      "import add",
      new ImportError({
        code: "import-location-invalid",
        message:
          "Name the provider: github:anthropics/skills. Tack does not guess where org/repo lives. Providers: github.",
        details: {
          reason: "location-provider-missing",
          suggestion: "github:anthropics/skills",
          next: [
            "tack",
            "import",
            "add",
            "github:anthropics/skills",
            "--skill",
            "pdf",
            "--into",
            "team-notes",
          ],
        },
      }),
    ),
  ],
  [
    "failure-location-unknown-provider",
    failed(
      "import add",
      new ImportError({
        code: "import-location-invalid",
        message: "Tack has no import provider named gitlab. Providers: github.",
        details: { reason: "location-provider-unknown" },
      }),
    ),
  ],
  [
    "failure-destination-required",
    failed(
      "import add",
      new ImportError({
        code: "import-destination-required",
        message:
          "--apply needs --into SOURCE[:FOLDER], the source that receives the skills. Run `tack source` to list registered sources.",
      }),
    ),
  ],
];

const snapshotPath = (name: string) =>
  new URL(`../../../../test/fixtures/human/import-${name}.txt`, import.meta.url);

describe("import human views", () => {
  it.each(cases)("renders %s as the reference text", (name, envelope) => {
    const actual = render(envelope);
    if (process.env["UPDATE_IMPORT_VIEWS"] === "1") writeFileSync(snapshotPath(name), actual);
    expect(actual).toBe(readFileSync(snapshotPath(name), "utf8"));
  });

  it.each(cases)("%s keeps the view contract and ends in one newline", (_name, envelope) => {
    expectViewContract(envelope, terminal);
    for (const width of [40, 80, 120]) {
      const output = render(envelope, width);
      expect(output.endsWith("\n")).toBe(true);
      expect(output.endsWith("\n\n")).toBe(false);
    }
  });

  it.effect("offers hints that parse as the import commands they name", () =>
    Effect.gen(function* () {
      const operations = yield* Effect.forEach(cases, ([, envelope]) =>
        parseHintsIn(render(envelope)),
      );
      const named = operations.flat();
      expect(named.length).toBeGreaterThan(8);
      expect(new Set(named)).toEqual(
        new Set(
          [
            "import add",
            "import remove",
            "import",
            "sync",
            "tack source".slice(5),
            "source",
          ].filter((name) => named.includes(name)),
        ),
      );
      expect(
        named.every((name) =>
          ["import add", "import remove", "import", "sync", "source"].includes(name),
        ),
      ).toBe(true);
    }),
  );

  it("falls back to the generic view when a payload does not decode", () => {
    const undecodable = createPublicEnvelope("import add", {
      classification: "success",
      diagnostics: [],
      plan: { kind: "import-plan" },
    });
    expect(importViews["import add"]?.(undecodable, styleOf(terminal))).toBeUndefined();
    const brokenApplied = createPublicEnvelope("import add", {
      classification: "success",
      diagnostics: [],
      plan: toJson(basePlan),
      applied: { kind: "nonsense" },
    });
    expect(importViews["import add"]?.(brokenApplied, styleOf(terminal))).toBeUndefined();
    expect(importViews["import"]?.(undecodable, styleOf(terminal))).toBeUndefined();
    expect(importViews["import remove"]?.(undecodable, styleOf(terminal))).toBeUndefined();
    const brokenRemoval = createPublicEnvelope("import remove", {
      classification: "success",
      diagnostics: [],
      plan: toJson(removalPlan),
      applied: { kind: "nonsense" },
    });
    expect(importViews["import remove"]?.(brokenRemoval, styleOf(terminal))).toBeUndefined();
  });
});

// Views read directly, with the hints they record

const registrationId = "00000000-0000-4000-8000-000000000001";

const smallCandidate = (
  overrides: Partial<ImportCandidate> & { readonly name: string },
): ImportCandidate => ({
  folder: `skills/${overrides.name}`,
  place: "skills",
  hidden: false,
  verdict: { importable: true },
  files: 1,
  bytes: 100,
  executables: 0,
  nonText: 0,
  symlinks: 0,
  submodules: 0,
  nestedSkills: [],
  ...overrides,
});

const plan = (overrides: Partial<ImportPlan>): ImportPlan => ({
  kind: "import-plan",
  location: "github:acme/skills",
  provider: "github",
  transport: "https",
  ref: { kind: "default", tracking: true },
  revision,
  candidates: [],
  hiddenInternal: 0,
  selected: [],
  writes: [],
  reach: [],
  outcome: "needs-selection",
  ...overrides,
});

const renderRecorded = (command: string, input: { plan?: unknown; applied?: unknown }) => {
  const view = importViews[command];
  if (view === undefined) throw new Error(`No import view for ${command}.`);
  const { hints, style } = hintRecorder();
  const text = view(envelopeOf({ command, ...input }), style);
  return { hints, text: text ?? "", flatText: flat(text) };
};

describe("import add preview", () => {
  it("shows a root skill without a description and the upstream Tack metadata that stays opt-in", () => {
    const { text, flatText, hints } = renderRecorded("import add", {
      plan: plan({
        candidates: [
          smallCandidate({
            name: "solo",
            folder: "",
            upstreamTack: {
              activation: "opt-in",
              userActivation: "opt-in",
              projects: [],
              dependencies: [],
            },
          }),
          smallCandidate({
            name: "wide",
            description: "Reaches everywhere.",
            upstreamTack: {
              activation: "default",
              userActivation: "default",
              projects: ["demo"],
              dependencies: [{ kind: "skill", name: "helper" }],
            },
          }),
        ],
        destinations: [
          { name: "empty", registrationId, folders: [] },
          { name: "personal-brain", registrationId, folders: ["skills", "tools"] },
        ],
      }),
    });
    expect(text).toMatch(
      /· +solo +\(root\)\n {6}1 file, 100 B\n {6}upstream metadata\.tack: activation opt-in · user activation opt-in\n/,
    );
    expect(flatText).toContain(
      "upstream metadata.tack: activation default · user activation default (reaches the user namespace) · projects demo · 1 dependency",
    );
    expect(hints).toEqual([
      "tack import add github:acme/skills --skill solo --into personal-brain:skills",
    ]);
  });

  it("names a destination with a single folder by its source alone and lists no writes without one", () => {
    const { flatText, hints } = renderRecorded("import add", {
      plan: plan({
        candidates: [smallCandidate({ name: "pdf" })],
        selected: ["pdf"],
        destinations: [{ name: "personal-brain", registrationId, folders: ["skills"] }],
        writes: [
          { name: "pdf", path: "skills/pdf", upstreamPath: "skills/pdf", files: 1, bytes: 100 },
        ],
        outcome: "needs-destination",
      }),
    });
    expect(flatText).not.toContain("Writes");
    expect(hints).toEqual([
      "tack import add github:acme/skills --skill pdf --into personal-brain --apply",
    ]);
  });
});

describe("import add into a skills collection", () => {
  it("names the collection by its source alone, in choices, the destination and the hint", () => {
    const choices = renderRecorded("import add", {
      plan: plan({
        candidates: [smallCandidate({ name: "pdf" })],
        selected: ["pdf"],
        destinations: [{ name: "flat", registrationId, folders: [""] }],
        outcome: "needs-destination",
      }),
    });
    expect(choices.flatText).toContain("receives the skills. flat flat Next");
    expect(choices.hints).toEqual([
      "tack import add github:acme/skills --skill pdf --into flat --apply",
    ]);
    const into = renderRecorded("import add", {
      plan: plan({
        candidates: [smallCandidate({ name: "pdf" })],
        selected: ["pdf"],
        destination: { ...destination, source: "flat", folder: "", declaredFolder: "" },
        writes: [{ name: "pdf", path: "pdf", upstreamPath: "skills/pdf", files: 1, bytes: 100 }],
      }),
    });
    expect(into.flatText).toContain("Into flat · ~/notes Skills");
    expect(into.flatText).toContain("Will write pdf/ 1 file");
    expect(into.hints).toEqual(["tack import add github:acme/skills --skill pdf --into flat"]);
  });
});

describe("import remove view", () => {
  const removal = (local: ImportRemovalPlan["local"]): ImportRemovalPlan => ({
    kind: "import-removal-plan",
    reference: "personal-brain:pdf",
    source: "personal-brain",
    registrationId,
    name: "pdf",
    path: "skills/pdf",
    location: "github:acme/skills",
    revision,
    folderPresent: true,
    files: 3,
    local,
    delivered: [],
    picks: [],
    force: true,
  });

  it("lists a changed executable bit and a special file among the local changes it loses", () => {
    const { text, hints } = renderRecorded("import remove", {
      plan: removal({
        state: "changed",
        added: [],
        removed: [],
        changed: [],
        executable: ["run.sh"],
        special: ["link"],
      }),
    });
    expect(text).toContain("Local changes that will be lost (2)\n");
    expect(text).toContain(
      "  ✗ run.sh executable bit changed\n  ✗ link is a link or special file\n",
    );
    expect(hints).toEqual(["tack import remove personal-brain:pdf --force --apply"]);
  });

  it("reports an applied removal that recovered nothing first", () => {
    const { text } = renderRecorded("import remove", {
      plan: removal({
        state: "unchanged",
        added: [],
        removed: [],
        changed: [],
        executable: [],
        special: [],
      }),
      applied: {
        kind: "import-removal-application",
        reference: "personal-brain:pdf",
        removed: ["skills/pdf", "tack.yaml"],
        recovered: [],
      },
    });
    expect(text).toContain("Removed personal-brain:pdf\n");
    expect(text).not.toContain("Recovered first");
  });
});
