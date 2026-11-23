import { describe, expect, it } from "vitest";
import { bundleSourceLabel } from "../../../domain/bundles/bundle-registration.ts";
import { envelopeOf, flat, plainStyle, styleOf, testHome } from "./human.test-support.ts";
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

const projectRoot = "/home/me/project";
const projectTarget = { _tag: "project-root", projectName: "demo", canonicalPath: projectRoot };
const linkCreate = (name: string, registrationId = sourceId) => ({
  _tag: "link-create",
  destinationPath: `${projectRoot}/.claude/skills/${name}`,
  evidence: {
    adapter: "claude",
    address: { kind: "skill", name, owner: "shared", sourceRegistrationId: registrationId },
    sourceDirectoryPath: `/home/me/source/skills/${name}`,
    sourceRegistrationId: registrationId,
    target: projectTarget,
  },
  relativeTarget: `../../../source/skills/${name}`,
});
const directoryCreate = {
  _tag: "directory-create",
  directoryPath: `${projectRoot}/.claude/skills`,
};
/**
 * The sync plan a profile application carries, as its payload publishes it: one claude unit, and
 * the project's docs plan, empty unless given.
 */
const syncOf = (
  actions: ReadonlyArray<unknown>,
  docs: ReadonlyArray<unknown> = [
    { kind: "docs-reconciliation-plan", actions: [], complete: true, issues: [] },
  ],
) => ({
  docs,
  docsPending: [],
  resources: {
    causes: [],
    projectNames: ["demo"],
    selection: { selector: { _tag: "project", projectName: "demo" }, targets: [projectTarget] },
    plan: {
      kind: "skill-reconciliation-plan",
      version: 1,
      namespaceResolutions: [],
      units: [
        {
          adapter: "claude",
          target: projectTarget,
          actions,
          collisions: [],
          conflicts: [],
          delivery: { command: "unsupported", skill: "delivered" },
          summary: {
            adopt: 0,
            blocked: 0,
            collision: 0,
            conflict: 0,
            create: actions.length,
            release: 0,
            remove: 0,
            retire: 0,
          },
        },
      ],
    },
  },
});

const applyPlan = (overrides: Record<string, unknown> = {}) => ({
  kind: "profile-apply",
  reference: "personal-brain:daily",
  refused: false,
  targets: [projectRoot],
  existing: [],
  direct: [skill("review")],
  required: [command("ship")],
  findings: [],
  effects: [
    `directory-create: ${projectRoot}/.claude/skills`,
    `link-create: ${projectRoot}/.claude/skills/review`,
  ],
  sync: syncOf([directoryCreate, linkCreate("review")]),
  delivery: {
    notes: ["Claude reads commands from .claude/commands."],
    skipped: [],
    incomplete: false,
  },
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
            skipped: [],
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
        "claude → demo · 2 to link",
        "  create  .claude/skills/        directory",
        "  create  .claude/skills/review  skill review",
        "",
        "Ambient user instructions and release-owned skills remain outside this target's profile control.",
        "",
      ].join("\n"),
    );
  });

  it("lists each member an enabled agent cannot take under that agent, with the reason", () => {
    const skip = (adapter: string) => ({
      member: `command ${sourceId}:ship`,
      adapter,
      reason: `Tack does not link commands for ${adapter}`,
    });
    const text = renderProfileApply(
      envelopeOf({
        command: "profile apply",
        plan: applyPlan({
          delivery: {
            notes: [
              `skill ${sourceId}:review: claude → .claude/skills/review`,
              `command ${sourceId}:ship: Tack does not link commands for claude`,
              `command ${sourceId}:ship: Tack does not link commands for codex`,
            ],
            skipped: [skip("claude"), skip("codex")],
            incomplete: false,
          },
        }),
      }),
      labelled,
    );
    expect(text).toContain(
      [
        "skill review: claude → .claude/skills/review",
        "",
        "Skipped for claude",
        "  command ship: Tack does not link commands for claude",
        "",
        "Skipped for codex",
        "  command ship: Tack does not link commands for codex",
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
          bundle: {
            ...manifest,
            identity: digest("b"),
            sources: manifest.sources.map(({ name: _name, ...source }) => source),
          },
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
      `Retained source ${bundleSourceLabel({ identity: digest("b"), sourceKey: "personal-brain" })} · from personal-brain · ~/.tack/personal-brain\n`,
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

  it("shows each delivery action's outcome once applied, never the raw effects", () => {
    const text = renderProfileApply(
      envelopeOf({
        command: "profile apply",
        plan: applyPlan(),
        applied: {
          docs: [],
          docsPending: [],
          resources: {
            kind: "skill-reconciliation-application",
            version: 1,
            units: [
              {
                adapter: "claude",
                target: projectTarget,
                status: "success",
                actions: [
                  { _tag: "applied", action: directoryCreate },
                  { _tag: "applied", action: linkCreate("review") },
                ],
              },
            ],
          },
        },
      }),
      labelled,
    );
    expect(text).toContain(
      [
        "claude → demo · 2 to link",
        "  applied  create  .claude/skills/        directory",
        "  applied  create  .claude/skills/review  skill review",
      ].join("\n"),
    );
    expect(text).not.toContain("link-create:");
    expect(text).not.toContain(projectRoot);
  });

  it.each([
    { targets: [projectRoot], shown: ".claude/skills/review" },
    { targets: [projectRoot, "/home/me/worktree"], shown: "~/project/.claude/skills/review" },
  ])(
    "shows a delivery note's destination relative to its one target: $targets",
    ({ targets, shown }) => {
      const text = renderProfileApply(
        envelopeOf({
          command: "profile apply",
          plan: applyPlan({
            targets,
            delivery: {
              notes: [
                `skill ${sourceId}:review: claude → ${projectRoot}/.claude/skills/review`,
                "Claude reads commands from .claude/commands.",
              ],
              skipped: [],
              incomplete: false,
            },
          }),
        }),
        labelled,
      );
      expect(text).toContain(
        `skill review: claude → ${shown}\nClaude reads commands from .claude/commands.\n`,
      );
    },
  );

  const docsCreate = {
    action: "create",
    evidence: {
      destinationPath: `${projectRoot}/docs/guide`,
      projectName: "demo",
      relativeTarget: "../../source/docs/guide",
      resource: { name: "guide", sourceRegistrationId: sourceId },
      root: projectRoot,
      sourceDirectoryPath: "/home/me/source/docs/guide",
    },
  };
  it.each([
    { state: "planned", applied: null, row: "+ create ~/project/docs/guide" },
    {
      state: "applied",
      applied: {
        resources: { kind: "skill-reconciliation-application", version: 1, units: [] },
        docs: [
          {
            kind: "docs-reconciliation-application",
            actions: [{ _tag: "applied", action: docsCreate }],
            complete: true,
            issues: [],
          },
        ],
        docsPending: [],
      },
      row: "✓ applied create ~/project/docs/guide",
    },
  ])(
    "lists the docs links a profile delivers beside its agent links, $state",
    ({ applied, row }) => {
      const text = renderProfileApply(
        envelopeOf({
          command: "profile apply",
          plan: applyPlan({
            sync: syncOf(
              [],
              [
                {
                  kind: "docs-reconciliation-plan",
                  actions: [docsCreate],
                  complete: true,
                  issues: [],
                },
              ],
            ),
          }),
          applied,
        }),
        labelled,
      );
      expect(flat(text)).toContain(`Docs links ${row}`);
      expect(text).not.toContain("docs create:");
    },
  );

  const bundleId = "00000000-0000-4000-8000-0000000000b1";
  const label = bundleSourceLabel({ identity: digest("b"), sourceKey: "personal-brain" });
  it.each([
    {
      catalog: "does not hold the bundle yet",
      style: plainStyle,
      source: label,
      member: `${label}:review`,
    },
    {
      catalog: "already holds the bundle",
      style: styleOf({
        homeDirectory: testHome,
        width: 100,
        references: {
          entries: [{ address: { kind: "skill", name: "review" }, sourceRegistrationId: bundleId }],
          sources: [{ registration: { id: bundleId }, label: "kept" }],
        },
      }),
      source: "kept",
      member: "review",
    },
  ])(
    "names a bundle's members and sources by label when the catalog $catalog",
    ({ style, source, member }) => {
      const text = renderProfileApply(
        envelopeOf({
          command: "profile apply-bundle",
          plan: applyPlan({
            kind: "profile-apply-bundle",
            reference: `${label}:daily`,
            bundle: {
              ...manifest,
              identity: digest("b"),
              sources: manifest.sources.map((sent) => ({ ...sent, name: "brain" })),
            },
            sources: [
              {
                sourceKey: "personal-brain",
                registrationId: bundleId,
                path: "/home/me/.tack/bundles/b/sources/personal-brain",
              },
            ],
            direct: [{ kind: "skill", name: "review", sourceRegistrationId: bundleId }],
            required: [],
            delivery: {
              notes: [`skill ${bundleId}:review: claude → .claude/skills/review`],
              skipped: [],
              incomplete: false,
            },
            sync: syncOf([linkCreate("review", bundleId)]),
          }),
        }),
        style,
      );
      expect(text).not.toContain(bundleId);
      expect(text).toContain(
        `Retained source ${source} · from brain · ~/.tack/bundles/b/sources/personal-brain\n`,
      );
      expect(text).toContain(`  skill ${member}\n`);
      expect(text).toContain(`skill ${member}: claude → .claude/skills/review\n`);
      expect(flat(text)).toContain(`create .claude/skills/review skill ${member}`);
    },
  );
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
      // An inspection with no payload at all is a failure, which its own view shows.
      const candidates =
        commandPath === "profile inspect-bundle"
          ? [{ unexpected: true }, { kind: "other" }, []]
          : [{ unexpected: true }, { kind: "other" }, [], null];
      for (const candidate of candidates) {
        const envelope = envelopeOf({ command: commandPath, plan: candidate, result: candidate });
        expect(view(envelope, plainStyle), commandPath).toBeUndefined();
      }
    }
  });

  it("ends a bundle that cannot be inspected with the command its failure names", () => {
    const failure = envelopeOf({
      command: "profile inspect-bundle",
      classification: "domain",
      diagnostics: [
        {
          code: "profile-bundle-file-access-failed",
          severity: "error",
          message: "Bundle file /ci.tgz cannot be read: it does not exist.",
        },
      ],
    });
    const text = renderBundleInspection(
      { ...failure, next: ["tack profile export --help"] },
      plainStyle,
    );
    expect(text?.trimEnd().split("\n").slice(-2)).toEqual(["Next", "  tack profile export --help"]);
  });
});
