import { describe, expect, it } from "vitest";
import { envelopeOf, plainStyle, styleOf, testHome } from "./human.test-support.ts";
import { renderBundleExport, renderBundleInspection } from "./profile-bundle.ts";
import { renderProfileAdopt, renderProfileSave } from "./profile-copy.ts";
import { profileCheckLines, renderProfileApply } from "./profile.ts";

const sourceId = "00000000-0000-4000-8000-000000000001";
const skill = (name: string) => ({ kind: "skill", name, sourceRegistrationId: sourceId }) as const;
const command = (name: string) =>
  ({ kind: "command", name, sourceRegistrationId: sourceId }) as const;
const digest = (character: string) => character.repeat(64);
/** A terminal whose catalog holds the members, so each reads by its shortest reference. */
const labelled = styleOf({
  homeDirectory: testHome,
  width: 100,
  references: {
    entries: [
      { address: { kind: "skill", name: "review" }, sourceRegistrationId: sourceId },
      { address: { kind: "command", name: "ship" }, sourceRegistrationId: sourceId },
    ],
  },
});

describe("profile check lines", () => {
  it("lists direct and required members, then each finding with its file, field and fix", () => {
    const lines = profileCheckLines(
      {
        kind: "profile-check",
        sourcePath: "/home/me/source",
        profileName: "daily",
        structural: "invalid",
        linkage: "incomplete",
        direct: [skill("review")],
        required: [command("ship")],
        findings: [
          {
            code: "profile-member-missing",
            category: "linkage",
            severity: "error",
            message: "review is not in the catalog.",
            remedy: "Remove it.",
            file: "/home/me/source/profiles/daily.yaml",
            field: "members[0]",
          },
          {
            code: "profile-unused",
            category: "structure",
            severity: "warning",
            message: "Nothing uses it.",
            remedy: "Delete it.",
            file: "/elsewhere/daily.yaml",
          },
        ],
      },
      labelled,
    );
    expect(lines).toEqual([
      "Structure: invalid · Source linkage: incomplete",
      "Direct members (1)",
      "  skill review",
      "Required dependencies (1)",
      "  command ship",
      "error: profile-member-missing: review is not in the catalog.",
      "  ~/source/profiles/daily.yaml · members[0]",
      "  Fix: Remove it.",
      "warning: profile-unused: Nothing uses it.",
      "  /elsewhere/daily.yaml",
      "  Fix: Delete it.",
    ]);
  });
});

const applyPlan = (overrides: Record<string, unknown> = {}) => ({
  kind: "profile-apply",
  reference: "personal-brain:daily",
  refused: false,
  targets: ["/home/me/project"],
  existing: [],
  direct: [skill("review")],
  required: [command("ship")],
  findings: [],
  effects: ["link skill review"],
  delivery: { notes: ["Claude reads commands from .claude/commands."], incomplete: false },
  ...overrides,
});

describe("profile apply view", () => {
  it("previews the fixed members, target and delivery effects", () => {
    const text = renderProfileApply(
      envelopeOf({
        command: "profile apply",
        plan: applyPlan({
          delivery: {
            notes: [
              "Claude reads commands from .claude/commands.",
              `skill ${sourceId}:review: claude → .claude/skills/review`,
            ],
            incomplete: false,
          },
        }),
      }),
      labelled,
    );
    expect(text).toBe(
      [
        "tack profile apply · ✓ success",
        "",
        "Fixed profile personal-brain:daily · preview",
        "Target: ~/project",
        "Existing selection: none (computed defaults do not count)",
        "",
        "Direct members (1)",
        "  skill review",
        "Required dependencies (1)",
        "  command ship",
        "",
        "Claude reads commands from .claude/commands.",
        "skill review: claude → .claude/skills/review",
        "",
        "link skill review",
        "",
        "Ambient user instructions and release-owned skills remain outside this target's profile control.",
        "",
      ].join("\n"),
    );
  });

  it("names the verified bundle, its retained sources and the existing selection once applied", () => {
    const text = renderProfileApply(
      envelopeOf({
        command: "profile apply-bundle",
        plan: applyPlan({
          kind: "profile-apply-bundle",
          bundle: { ...manifest, identity: digest("b") },
          sources: [
            {
              sourceKey: "personal-brain",
              registrationId: sourceId,
              path: "/home/me/.tack/personal-brain",
            },
          ],
          existing: ["skill review", "skill audit"],
          findings: [{ code: "profile-drift", message: "Selection differs." }],
        }),
        applied: { kind: "profile-apply-application" },
      }),
      plainStyle,
    );
    expect(text).toContain("Fixed profile personal-brain:daily · intent retained\n");
    expect(text).toContain(`Verified bundle: ${digest("b")}\n`);
    expect(text).toContain(
      `Retained source personal-brain → ${sourceId} · ~/.tack/personal-brain\n`,
    );
    expect(text).toContain("Existing selection: skill review, skill audit\n");
    expect(text).toContain("profile-drift: Selection differs.\n");
  });

  it("says a refused apply stopped before mutation, even without listed sources", () => {
    const text = renderProfileApply(
      envelopeOf({
        command: "profile apply-bundle",
        classification: "domain",
        plan: applyPlan({
          kind: "profile-apply-bundle",
          refused: true,
          bundle: { ...manifest, identity: digest("c") },
          sources: [],
        }),
      }),
      plainStyle,
    );
    expect(text).toContain("Fixed profile personal-brain:daily · refused before mutation\n");
    expect(text).toContain(`Verified bundle: ${digest("c")}\nTarget: ~/project\n`);
  });
});

const savePlan = (overrides: Record<string, unknown> = {}) => ({
  kind: "profile-save",
  input: { user: true, projectName: "demo" },
  file: "/home/me/source/profiles/daily.yaml",
  members: [{ address: skill("review"), origins: ["project demo", "user"] }],
  notes: ["Copied from the daily selection."],
  profileBefore: "",
  profileAfter: "members: [review]",
  publicationBefore: "profiles: []",
  publicationAfter: "profiles: [daily]",
  added: [skill("review")],
  removed: [command("ship")],
  findings: [{ code: "profile-copy-note", message: "One member is opt-in." }],
  ...overrides,
});

describe("profile save view", () => {
  it("previews the new profile file and the publication change", () => {
    expect(
      renderProfileSave(envelopeOf({ command: "profile save", plan: savePlan() }), labelled),
    ).toBe(
      [
        "tack profile save · ✓ success",
        "",
        "Copy daily selection → profile · preview",
        "~/source/profiles/daily.yaml",
        "",
        "Copied from the daily selection.",
        "",
        "skill review · project demo, user",
        "",
        "+ skill review",
        "- command ship",
        "",
        "--- profile before",
        "(new file)",
        "+++ profile after",
        "members: [review]",
        "",
        "--- tack.yaml before",
        "profiles: []",
        "+++ tack.yaml after",
        "profiles: [daily]",
        "",
        "profile-copy-note: One member is opt-in.",
        "",
        "Save changes only the source profile/publication. Daily choices and links remain independent.",
        "",
      ].join("\n"),
    );
  });

  it("shows the old profile and an unchanged publication once saved", () => {
    const text = renderProfileSave(
      envelopeOf({
        command: "profile save",
        plan: savePlan({
          profileBefore: "members: []",
          publicationAfter: "profiles: []",
        }),
        applied: { kind: "profile-save-application" },
      }),
      plainStyle,
    );
    expect(text).toContain("Copy daily selection → profile · saved\n");
    expect(text).toContain("--- profile before\nmembers: []\n");
    expect(text).toContain("\nPublication unchanged.\n");
    expect(text).not.toContain("tack.yaml before");
  });
});

describe("profile adopt view", () => {
  const adoptPlan = {
    kind: "profile-adopt",
    reference: "personal-brain:daily",
    namespace: { _tag: "project", projectName: "demo" },
    includes: [skill("review")],
    attachments: [command("ship")],
    notes: ["Docs stay attached."],
    blockers: ["dependency-blocked"],
    findings: [{ code: "profile-opt-in", message: "review is opt-in." }],
  };

  it("previews what the daily selection would include and attach, and what still blocks it", () => {
    expect(
      renderProfileAdopt(envelopeOf({ command: "profile adopt", plan: adoptPlan }), labelled),
    ).toBe(
      [
        "tack profile adopt · ✓ success",
        "",
        "Copy profile personal-brain:daily → daily selection · preview",
        "",
        "include skill review",
        "attach command ship",
        "",
        "Docs stay attached.",
        "",
        "Remaining ordinary blocker: dependency-blocked",
        "",
        "profile-opt-in: review is opt-in.",
        "",
      ].join("\n"),
    );
  });

  it("says adopted once applied", () => {
    expect(
      renderProfileAdopt(
        envelopeOf({ command: "profile adopt", plan: adoptPlan, applied: { done: true } }),
        plainStyle,
      ),
    ).toContain("Copy profile personal-brain:daily → daily selection · adopted\n");
  });
});

const manifest = {
  version: 1,
  identity: digest("a"),
  profile: { sourceKey: "personal-brain", name: "daily", path: "profiles/daily.yaml" },
  sources: [
    {
      key: "personal-brain",
      name: "personal-brain",
      bindings: { helpers: "helpers" },
      resources: [
        {
          kind: "skill",
          name: "review",
          path: "skills/review",
          direct: true,
          provenance: {
            location: "https://example.test/repo.git",
            revision: "abc123",
            upstreamPath: "skills/review",
            importedDigest: digest("d"),
            currentDigest: digest("e"),
          },
        },
      ],
      prerequisites: ["Install ripgrep."],
    },
    {
      key: "helpers",
      bindings: {},
      resources: [{ kind: "command", name: "ship", path: "commands/ship.md", direct: false }],
      prerequisites: [],
    },
  ],
  files: [
    { path: "skills", kind: "directory", size: 0, mode: 0o755, sha256: digest("0") },
    { path: "skills/review/SKILL.md", kind: "file", size: 12, mode: 0o644, sha256: digest("1") },
  ],
};
const inventory = [
  `Bundle version 1 · ${digest("a")}`,
  "Profile daily · defining source personal-brain",
  "Source personal-brain · personal-brain",
  "  source requirement helpers → helpers",
  `  direct skill review · skills/review · imported from https://example.test/repo.git @ abc123; current bytes ${digest("e")}`,
  "  Setup: Install ripgrep.",
  "Source helpers",
  "  required command ship · commands/ship.md",
].join("\n");
const payload = [
  "Exact payload (2 files/directories)",
  `  dir  755 0 B skills · sha256 ${digest("0")}`,
  `  file 644 12 B skills/review/SKILL.md · sha256 ${digest("1")}`,
].join("\n");

describe("profile export view", () => {
  it("previews the inventory and exact payload of the snapshot", () => {
    const text = renderBundleExport(
      envelopeOf({
        command: "profile export",
        plan: {
          kind: "profile-export",
          reference: "personal-brain:daily",
          output: "/home/me/daily.tackbundle",
          manifest,
          files: manifest.files,
          findings: [],
          refused: false,
        },
      }),
      plainStyle,
    );
    expect(text).toContain("Content snapshot personal-brain:daily · preview\n~/daily.tackbundle\n");
    expect(text).toContain(`\n${inventory}\n\n${payload}\n`);
  });

  it("shows refusals without an inventory when no manifest could be built", () => {
    const text = renderBundleExport(
      envelopeOf({
        command: "profile export",
        classification: "domain",
        plan: {
          kind: "profile-export",
          reference: "personal-brain:daily",
          output: "/tmp/daily.tackbundle",
          files: [],
          findings: [{ code: "bundle-sensitive-path", message: ".env is refused." }],
          refused: true,
        },
        applied: { exported: true },
      }),
      plainStyle,
    );
    expect(text).toContain(
      "Content snapshot personal-brain:daily · exported\n/tmp/daily.tackbundle\n",
    );
    expect(text).not.toContain("Bundle version");
    expect(text).toContain(
      "Exact payload (0 files/directories)\n\nbundle-sensitive-path: .env is refused.\n",
    );
  });
});

describe("profile inspect-bundle view", () => {
  it("reads out the inventory and payload without validating them", () => {
    const text = renderBundleInspection(
      envelopeOf({
        command: "profile inspect-bundle",
        result: { kind: "profile-bundle-inspection", file: "/home/me/daily.tackbundle", manifest },
      }),
      plainStyle,
    );
    expect(text).toContain(
      `Content bundle inventory · ~/daily.tackbundle\n\n${inventory}\n\n${payload}\n`,
    );
    expect(text).toContain("Inventory read-out only.");
  });
});

describe("profile views", () => {
  it("decline a payload their producer's schema does not decode", () => {
    const views = {
      "profile apply": renderProfileApply,
      "profile apply-bundle": renderProfileApply,
      "profile save": renderProfileSave,
      "profile adopt": renderProfileAdopt,
      "profile export": renderBundleExport,
      "profile inspect-bundle": renderBundleInspection,
    };
    for (const [commandPath, view] of Object.entries(views)) {
      for (const candidate of [{ unexpected: true }, { kind: "other" }, [], null]) {
        const envelope = envelopeOf({ command: commandPath, plan: candidate, result: candidate });
        expect(view(envelope, plainStyle), commandPath).toBeUndefined();
      }
    }
  });
});
