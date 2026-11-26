import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  catalogAddressCandidates,
  ChoiceRemovalPayloadSchema,
} from "../../../features/choices/choice.ts";
import type { SetSkillChoiceResult } from "../../../features/choices/choice.ts";
import { DocsSettingsPayloadSchema } from "../../../features/docs/docs.ts";
import {
  ProjectRegistrationPayloadSchema,
  type RegisterProjectResult,
} from "../../../features/projects/project.ts";
import {
  AdapterSettingsPayloadSchema,
  type SetEnabledAdaptersResult,
} from "../../../features/reconciliation/agent.ts";
import { AgentSelectionValidationError } from "../../../features/reconciliation/agent.ts";
import {
  ChoiceProjectNotFoundError,
  ChoiceProjectRemovingError,
} from "../../../features/choices/choice.ts";
import { DocsError, type DocsProject } from "../../../domain/docs/docs-schema.ts";
import { ProjectRegistrationConflictError } from "../../../features/projects/project.ts";
import {
  SourcePathConflictError,
  SourceRegistrationNotFoundError,
  SourceRegistrationPayloadSchema,
  SourceRelocationPayloadSchema,
  SourceValidationError,
  type SourceMutationResult,
  type SourceRelocationResult,
} from "../../../features/sources/source.ts";
import {
  StateInitializationPayloadSchema,
  StateNotInitializedError,
} from "../../../services/state-store.ts";
import { SourceAddRequestError } from "../../../features/sources/source-scaffold.ts";
import { outcomeForError } from "../errors.ts";
import { appliedAs, appliedOutcome, choiceSetOutcome, type PayloadFields } from "../outcomes.ts";
import {
  expectViewContract,
  flat,
  lines,
  renderView,
  styleOf,
  testHome,
} from "./human.test-support.ts";
import { mutationViews } from "./mutation-views.ts";
import { renderHuman } from "./render.ts";
import { createPublicEnvelope, type PublicEnvelope } from "../public-outcome.ts";
import { hintsIn, parseHintsIn } from "../../../../test/support/hints.ts";

/** The catalog the views read their shortest references from: `review` is unique, `reveiw` is not in it. */
const references = {
  entries: ["review", "reviw"].map((name) => ({
    address: { kind: "skill", name },
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  })),
  sources: [
    {
      registration: { id: "00000000-0000-4000-8000-000000000001" },
      label: "skills",
      labelOrigin: "declared",
    },
  ],
};

const terminal = { homeDirectory: testHome, references, views: mutationViews } as const;

const view = (envelope: PublicEnvelope, width = 80) => renderView(envelope, { ...terminal, width });

const style = () => styleOf(terminal);

/** The payload schema each mutation's route builds its envelope from. */
const payloadSchemas = {
  "state init": StateInitializationPayloadSchema,
  "source add": SourceRegistrationPayloadSchema,
  "source relocate": SourceRelocationPayloadSchema,
  "project add": ProjectRegistrationPayloadSchema,
  "pick remove": ChoiceRemovalPayloadSchema,
  "adapter enable": AdapterSettingsPayloadSchema,
  "docs attach": DocsSettingsPayloadSchema,
  "docs detach": DocsSettingsPayloadSchema,
  "docs configure": DocsSettingsPayloadSchema,
} as const;

/** The envelope a mutation's route publishes for the given producer result. */
const applied = <Command extends keyof typeof payloadSchemas>(
  command: Command,
  payload: PayloadFields<(typeof payloadSchemas)[Command]>,
) => createPublicEnvelope(command, appliedAs(payloadSchemas[command])(payload));

const failed = (command: string, error: Parameters<typeof outcomeForError>[0]) =>
  createPublicEnvelope(command, outcomeForError(error));

const registrationId = "00000000-0000-4000-8000-000000000001";
const sourcePath = "/home/me/code/skills";

/** A registration `source add` reports, named `skills` unless `name` says otherwise. */
const sourceAdded = (
  alreadyRegistered: boolean,
  docs: SourceMutationResult["docs"] = [],
  extra: { readonly name?: string; readonly scaffolded?: string } = {},
) =>
  applied("source add", {
    ...({
      alreadyRegistered,
      docs,
      registration: { canonicalPath: sourcePath, id: registrationId },
    } satisfies SourceMutationResult),
    name: "skills",
    ...extra,
  });

const demoProject = (
  alreadyRegistered: boolean,
  handMade: RegisterProjectResult["handMade"] = [],
) =>
  applied("project add", {
    alreadyRegistered,
    project: {
      gitCommonDirectory: "/home/me/code/demo/.git",
      name: "demo",
      roots: ["/home/me/code/demo", "/home/me/code/demo-wt"],
    },
    handMade,
  } satisfies RegisterProjectResult);

const review = { kind: "skill", name: "review", sourceRegistrationId: registrationId } as const;
const typo = { kind: "skill", name: "reveiw", sourceRegistrationId: registrationId } as const;
const projectDemo = { _tag: "project", projectName: "demo" } as const;

const choiceSet = (
  changed: boolean,
  address: SetSkillChoiceResult["choice"]["address"],
  namespace: SetSkillChoiceResult["choice"]["namespace"] = projectDemo,
  decision: "include" | "exclude" = "include",
) => {
  const result = {
    changed,
    choice: { address, decision, namespace },
  } satisfies SetSkillChoiceResult;
  const catalog: Parameters<typeof catalogAddressCandidates>[0] = {
    entries: [
      { address: review },
      { address: { kind: "skill", name: "reviw", sourceRegistrationId: registrationId } },
      { address: { kind: "script", name: "reveiw", sourceRegistrationId: registrationId } },
    ],
  };
  return createPublicEnvelope(
    decision === "exclude" ? "pick exclude" : "pick include",
    choiceSetOutcome(result, catalogAddressCandidates(catalog, address), []),
  );
};

const docsSettings = (settings: DocsProject) => settings;
const handbook = {
  name: "handbook",

  sourceRegistrationId: registrationId,
} as const;
const notes = {
  name: "notes",

  sourceRegistrationId: "00000000-0000-4000-8000-000000000002",
} as const;

describe("init", () => {
  it.effect("confirms a fresh initialization and points at tack init", () =>
    Effect.gen(function* () {
      const output = view(
        applied("state init", {
          alreadyInitialized: false,
          stateDirectory: "/home/me/.tack",
        }),
      );
      expect(lines(output)[0]).toBe("tack state init · ✓ success");
      expect(lines(output)).toContain("Initialized Tack state in ~/.tack.");
      expect(hintsIn(output)).toEqual(["tack init"]);
      expect(yield* parseHintsIn(output)).toEqual(["init"]);
    }),
  );

  it("says an existing state was kept, and still points at tack init", () => {
    const output = view(
      applied("state init", { alreadyInitialized: true, stateDirectory: "/home/me/.tack" }),
    );
    expect(lines(output)).toContain(
      "Tack was already initialized in ~/.tack; the existing state was kept.",
    );
    expect(hintsIn(output)).toEqual(["tack init"]);
  });
});

describe("source add", () => {
  it.effect("confirms a registration, lists declared docs and names where they go next", () =>
    Effect.gen(function* () {
      // The route names the next commands: a source with problems is checked, then linked.
      const output = view({
        ...sourceAdded(false, [{ name: "handbook" }, { name: "notes" }]),
        next: ["tack check /home/me/code/skills", "tack sync --project demo"],
      });
      expect(lines(output)[0]).toBe("tack source add · ✓ success");
      expect(lines(output)[2]).toBe("Registered source skills (~/code/skills).");
      expect(lines(output)).toContain(`  id    ${registrationId}`);
      expect(lines(output)).toContain("  docs  handbook");
      expect(lines(output)).toContain("        notes");
      expect(hintsIn(output)).toEqual([
        "tack check /home/me/code/skills",
        "tack sync --project demo",
      ]);
      expect(yield* parseHintsIn(output)).toEqual(["check", "sync"]);
    }),
  );

  it.effect("previews the tack.yaml its kind flags declare and what each entry finds", () =>
    Effect.gen(function* () {
      const brain = `${testHome}/brain`;
      const envelope = {
        ...createPublicEnvelope("source add", {
          classification: "partial",
          diagnostics: [
            {
              code: "skill-name-mismatch",
              message: "The skill folder name must equal name.",
              severity: "error",
              details: { file: `${brain}/personal/skills/lint/SKILL.md`, field: "skills[0]" },
            },
          ],
          plan: {
            kind: "source-scaffold",
            sourcePath: brain,
            declarationPath: `${brain}/tack.yaml`,
            name: "brain",
            content:
              "version: 1\nskills:\n  - path: personal/skills\ndocs:\n  - name: documents\n    path: alpha/documents\n",
            entries: [
              {
                kind: "skill",
                path: "personal/skills",
                resources: ["code-review", "commit-message", "deploy", "release-notes"],
                findings: [
                  {
                    code: "skill-name-mismatch",
                    message: "The skill folder name must equal name.",
                    severity: "error",
                    field: "skills[0]",
                    file: `${brain}/personal/skills/lint/SKILL.md`,
                  },
                ],
              },
              {
                kind: "docs",
                path: "alpha/documents",
                name: "documents",
                resources: ["documents"],
                findings: [],
              },
              { kind: "command", path: "prompts", resources: [], findings: [] },
            ],
          },
        }),
        next: [`tack source add ${brain} --skills personal/skills --docs alpha/documents --apply`],
      } satisfies PublicEnvelope;
      const output = view(envelope, 120);
      expect(lines(output)).toEqual([
        "tack source add · ! partial",
        "",
        "Would create ~/brain/tack.yaml and register source brain.",
        "No files or state changed.",
        "",
        "  version: 1",
        "  skills:",
        "    - path: personal/skills",
        "  docs:",
        "    - name: documents",
        "      path: alpha/documents",
        "",
        "skills personal/skills · 4 skills",
        "  code-review, commit-message, deploy, release-notes",
        "",
        "docs alpha/documents · 1 docs",
        "  documents",
        "",
        "commands prompts · 0 commands",
        "",
        "Problems",
        "  ✗ The skill folder name must equal name.",
        "    error skill-name-mismatch · file ~/brain/personal/skills/lint/SKILL.md · field skills[0]",
        "",
        "Next",
        `  tack source add ${brain} --skills personal/skills --docs alpha/documents --apply`,
        "",
      ]);
      expect(yield* parseHintsIn(output)).toEqual(["source add"]);
      expectViewContract(envelope, terminal);
    }),
  );

  it("says register the source when the preview has no name for it", () => {
    const output = view(
      createPublicEnvelope("source add", {
        classification: "success",
        diagnostics: [],
        plan: {
          kind: "source-scaffold",
          sourcePath: `${testHome}/tack`,
          declarationPath: `${testHome}/tack/tack.yaml`,
          content: "version: 1\nkind: skills\n",
          entries: [{ kind: "skill", collection: true, resources: ["review"], findings: [] }],
        },
        next: [],
      }),
    );
    expect(lines(output)).toContain("Would create ~/tack/tack.yaml and register the source.");
  });

  it("names the kind flags when a folder without tack.yaml has none, with each proposed command", () => {
    const output = view(
      failed(
        "source add",
        new SourceAddRequestError({
          code: "declaration-flags-required",
          message: `${testHome}/brain has no tack.yaml. Name the folders it holds with --skills, --commands, --context or --docs.`,
          next: [
            ["tack", "source", "add", `${testHome}/brain`, "--skills", "."],
            ["tack", "source", "add", `${testHome}/brain/commands`, "--commands", "."],
          ],
        }),
      ),
    );
    expect(flat(output)).toContain("declaration-flags-required");
    expect(flat(output)).toContain("--skills, --commands, --context or --docs");
    expect(hintsIn(output)).toEqual([
      `tack source add ${testHome}/brain --skills .`,
      `tack source add ${testHome}/brain/commands --commands .`,
    ]);
  });

  it("shows the same registration when the path was already registered", () => {
    const first = view(sourceAdded(false));
    const second = view(sourceAdded(true));
    expect(lines(second)).toContain(
      "Source skills (~/code/skills) is already registered; nothing changed.",
    );
    expect(lines(second)).toContain(`  id  ${registrationId}`);
    expect(lines(first)).toContain(`  id  ${registrationId}`);
    expect(second).not.toContain("docs");
  });

  it.each([
    {
      case: "names the source it created tack.yaml for",
      extra: { scaffolded: `${sourcePath}/tack.yaml` },
      says: "Created ~/code/skills/tack.yaml. Registered source skills (~/code/skills).",
    },
    {
      case: "names a source without a usable label by its path alone",
      extra: { name: registrationId },
      says: "Registered source ~/code/skills.",
    },
  ])("$case", (row) => {
    expect(lines(view(sourceAdded(false, [], row.extra)))).toContain(row.says);
  });
});

describe("source relocate", () => {
  const relocated = (relocatedFlag: boolean) =>
    applied("source relocate", {
      registration: { canonicalPath: "/home/me/code/moved", id: registrationId },
      relocated: relocatedFlag,
    } satisfies SourceRelocationResult);

  it("confirms the move and the unchanged repeat", () => {
    expect(flat(view(relocated(true)))).toContain(
      `Relocated source ${registrationId} to ~/code/moved.`,
    );
    expect(flat(view(relocated(false)))).toContain(
      `Source ${registrationId} already points at ~/code/moved; nothing changed.`,
    );
  });
});

describe("project add", () => {
  it.effect("confirms the project, shows anchor and roots and hints at pick include and plan", () =>
    Effect.gen(function* () {
      const output = view(demoProject(false));
      expect(lines(output)[0]).toBe("tack project add · demo · ✓ success");
      expect(lines(output)).toContain("Registered project demo.");
      expect(lines(output)).toContain("  anchor  ~/code/demo/.git");
      expect(lines(output)).toContain("  roots   ~/code/demo");
      expect(lines(output)).toContain("          ~/code/demo-wt");
      expect(hintsIn(output)).toEqual(["tack catalog", "tack sync --project demo"]);
      expect(yield* parseHintsIn(output)).toEqual(["catalog", "sync"]);
      expect(output).not.toContain("Hand-made");
    }),
  );

  it("lists the hand-made entries in the agent folders and keeps the same hints", () => {
    const output = view(
      demoProject(false, [
        {
          adapter: "claude",
          kind: "skill",
          path: "/home/me/code/demo/.claude/skills/code-review",
          entry: "directory",
        },
        {
          adapter: "cursor",
          kind: "command",
          path: "/home/me/code/demo-wt/.cursor/commands/ship.md",
          entry: "file",
        },
      ]),
    );
    const shown = lines(output);
    const heading = shown.indexOf("Hand-made, left untouched");
    expect(heading).toBeGreaterThan(shown.indexOf("Registered project demo."));
    expect(shown.slice(heading + 1, heading + 3)).toEqual([
      "  ~/code/demo/.claude/skills/code-review   folder · claude skill",
      "  ~/code/demo-wt/.cursor/commands/ship.md  file · cursor command",
    ]);
    expect(heading).toBeLessThan(shown.indexOf("Next"));
    expect(hintsIn(output)).toEqual(["tack catalog", "tack sync --project demo"]);
  });

  it("says nothing changed for a repeated registration", () => {
    expect(lines(view(demoProject(true)))).toContain(
      "Project demo is already registered; nothing changed.",
    );
  });

  it.effect("shell-quotes project names in hints", () =>
    Effect.gen(function* () {
      const envelope = applied("project add", {
        alreadyRegistered: false,
        project: {
          gitCommonDirectory: "/home/me/code/a/.git",
          name: "a.b-c_d",
          roots: ["/home/me/code/a"],
        },
        handMade: [],
      } satisfies RegisterProjectResult);
      expect(yield* parseHintsIn(view(envelope))).toEqual(["catalog", "sync"]);
    }),
  );
});

describe("pick include", () => {
  it.effect("confirms a change for a known address without a warning", () =>
    Effect.gen(function* () {
      const output = view(choiceSet(true, review));
      expect(lines(output)[0]).toBe("tack pick include · project demo · ✓ success");
      expect(lines(output)).toContain("Set skill review to include for project demo.");
      expect(output).not.toMatch(/^(Problems|Warnings|Notes)$/m);
      expect(hintsIn(output)).toEqual(["tack sync --project demo"]);
      expect(yield* parseHintsIn(output)).toEqual(["sync"]);
    }),
  );

  it("says nothing changed when the choice already held", () => {
    expect(lines(view(choiceSet(false, review, projectDemo, "exclude")))).toContain(
      "skill review is already set to exclude for project demo; nothing changed.",
    );
  });

  it.effect("confirms, warns and lists the candidate addresses for an unknown address", () =>
    Effect.gen(function* () {
      const output = view(choiceSet(true, typo));
      const all = lines(output);
      expect(all).toContain("Set skill skills:reveiw to include for project demo.");
      expect(all).toContain("Warnings");
      expect(all).toContain("    warning choice-address-not-in-catalog · skill skills:reveiw");
      expect(all.indexOf("Warnings")).toBeLessThan(all.indexOf("Closest catalog addresses"));
      expect(all).toContain("Closest catalog addresses");
      expect(all).toContain("  skill review");
      expect(all).toContain("  skill reviw");
      expect(all).not.toContain("  shared script reveiw");
      expect(all.indexOf("Closest catalog addresses")).toBeLessThan(all.indexOf("Next"));
      expect(hintsIn(output)).toEqual([
        "tack pick include reviw --kind skill --project demo",
        "tack pick remove skills:reveiw --kind skill --project demo",
        "tack sync --project demo",
      ]);
      expect(yield* parseHintsIn(output)).toEqual(["pick include", "pick remove", "sync"]);
    }),
  );

  it("states that no catalog address is close when the candidates are empty", () => {
    const far = { kind: "skill", name: "zzzzzz", sourceRegistrationId: registrationId } as const;
    const output = view(choiceSet(true, far));
    expect(lines(output)).toContain("  none; no catalog address is close to it");
    expect(hintsIn(output)).toEqual(["tack sync --project demo"]);
  });

  it.effect("addresses the user namespace", () =>
    Effect.gen(function* () {
      const output = view(choiceSet(true, review, { _tag: "user" }, "exclude"));
      expect(lines(output)[0]).toBe("tack pick exclude · user · ✓ success");
      expect(lines(output)).toContain("Set skill review to exclude for the user namespace.");
      expect(hintsIn(output)).toEqual(["tack sync --user"]);
      expect(yield* parseHintsIn(output)).toEqual(["sync"]);
    }),
  );
});

describe("pick remove", () => {
  const removal = (removed: boolean, namespace: SetSkillChoiceResult["choice"]["namespace"]) =>
    applied("pick remove", { address: review, namespace, removed });

  it.effect("confirms the removal and hints at plan", () =>
    Effect.gen(function* () {
      const output = view(removal(true, projectDemo));
      expect(lines(output)).toContain("Removed the choice for skill review from project demo.");
      expect(hintsIn(output)).toEqual(["tack sync --project demo"]);
      expect(yield* parseHintsIn(output)).toEqual(["sync"]);
    }),
  );

  it("says nothing changed when there was no such choice", () => {
    const output = view(removal(false, { _tag: "user" }));
    expect(lines(output)).toContain(
      "No choice for skill review exists in the user namespace; nothing changed.",
    );
    expect(hintsIn(output)).toEqual([]);
  });
});

describe("adapter enable", () => {
  const adapters = (result: SetEnabledAdaptersResult) => applied("adapter enable", result);

  it.effect("confirms the enabled set and hints at a plan that works outside a project", () =>
    Effect.gen(function* () {
      const output = view(adapters({ changed: true, enabledAdapters: ["claude", "codex"] }));
      expect(lines(output)).toContain("Enabled adapters are now claude, codex.");
      expect(hintsIn(output)).toEqual(["tack sync --all"]);
      expect(yield* parseHintsIn(output)).toEqual(["sync"]);
    }),
  );

  it("says nothing changed when the set already held", () => {
    const output = view(adapters({ changed: false, enabledAdapters: ["claude"] }));
    expect(lines(output)).toContain("Enabled adapters are already claude; nothing changed.");
    expect(hintsIn(output)).toEqual([]);
  });

  it("names an empty set", () => {
    expect(lines(view(adapters({ changed: false, enabledAdapters: [] })))).toContain(
      "Enabled adapters are already none; nothing changed.",
    );
  });
});

describe("docs attach, detach and configure", () => {
  const settings = docsSettings({
    attachments: [handbook, notes],
    defaultWritingResource: handbook,
    destination: "knowledge",
    projectName: "demo",
  });

  it.effect("attach lists the attachments and hints at sync for the project", () =>
    Effect.gen(function* () {
      const output = view(applied("docs attach", settings));
      expect(lines(output)[0]).toBe("tack docs attach · demo · ✓ success");
      expect(lines(output)).toContain(
        "Docs attach saved for project demo; it has 2 attached resources.",
      );
      expect(lines(output)).toContain("  attached     skills:handbook");
      expect(lines(output)).toContain("  destination  knowledge");
      expect(lines(output)).toContain("  default      skills:handbook");
      expect(hintsIn(output)).toEqual(["tack sync --no-adapters --project demo"]);
      expect(yield* parseHintsIn(output)).toEqual(["sync"]);
    }),
  );

  it.effect("detach reports what remains attached", () =>
    Effect.gen(function* () {
      const output = view(
        applied("docs detach", { attachments: [notes], projectName: "demo" } satisfies DocsProject),
      );
      expect(lines(output)).toContain(
        "Docs detach saved for project demo; 1 attached resource remains.",
      );
      expect(lines(output)).not.toContain("  destination");
      expect(yield* parseHintsIn(output)).toEqual(["sync"]);
    }),
  );

  it("detach of the last attachment says none remain", () => {
    const output = view(
      applied("docs detach", { attachments: [], projectName: "demo" } satisfies DocsProject),
    );
    expect(lines(output)).toContain(
      "Docs detach saved for project demo; no attached resources remain.",
    );
    expect(lines(output)).toContain("  attached  none");
  });

  it("configure shows the settings and offers no hint", () => {
    const output = view(applied("docs configure", settings));
    expect(lines(output)).toContain("Docs settings saved for project demo.");
    expect(lines(output)).toContain("  destination  knowledge");
    expect(hintsIn(output)).toEqual([]);
  });
});

describe("failures", () => {
  it.effect.each([
    { explicitDirectory: false, hint: "tack init", parsed: "init" },
    { explicitDirectory: true, hint: "tack --state-dir / state init", parsed: "state init" },
  ])("an uninitialized state names $hint", ({ explicitDirectory, hint, parsed }) =>
    Effect.gen(function* () {
      const error = new StateNotInitializedError({ statePath: "/x", explicitDirectory });
      const output = view(failed("source add", error));
      expect(lines(output)[0]).toBe("tack source add · ✗ invalid-configuration");
      expect(lines(output)).toContain("    error state-not-initialized · statePath /x");
      expect(hintsIn(output)).toEqual([hint]);
      expect(yield* parseHintsIn(output)).toEqual([parsed]);
    }),
  );

  it.effect("an unknown registration names source", () =>
    Effect.gen(function* () {
      const output = view(
        failed(
          "source relocate",
          new SourceRegistrationNotFoundError({
            code: "registration-not-found",
            registrationId,
          }),
        ),
      );
      expect(lines(output)[0]).toBe("tack source relocate · ✗ domain");
      expect(yield* parseHintsIn(output)).toEqual(["source"]);
    }),
  );

  it("renders a source validation or path conflict as header and diagnostics only", () => {
    const invalid = view(
      failed(
        "source add",
        new SourceValidationError({
          code: "declaration-missing",
          message: "No tack.yaml here.",
          sourcePath: "/x",
        }),
      ),
    );
    expect(invalid).toContain("No tack.yaml here.");
    expect(hintsIn(invalid)).toEqual([]);
    const conflict = view(
      failed(
        "source relocate",
        new SourcePathConflictError({
          code: "source-path-already-registered",
          conflictingRegistrationId: "00000000-0000-4000-8000-000000000009",
          registrationId,
          sourcePath: "/home/me/code/skills",
        }),
      ),
    );
    expect(conflict).toContain("source-path-already-registered");
    expect(hintsIn(conflict)).toEqual([]);
  });

  it.effect("a project registration conflict for the same repository names project refresh", () =>
    Effect.gen(function* () {
      const output = view(
        failed(
          "project add",
          new ProjectRegistrationConflictError({
            code: "project-registration-conflict",
            existingAnchor: "/a/.git",
            existingRoots: ["/a"],
            observedAnchor: "/a/.git",
            observedRoots: ["/a", "/a-wt"],
            projectName: "demo",
          }),
        ),
      );
      expect(output).toContain("project-registration-conflict");
      expect(hintsIn(output)).toEqual(["tack project refresh --project demo"]);
      expect(yield* parseHintsIn(output)).toEqual(["project refresh"]);
    }),
  );

  it("a project registration conflict for another repository has no hint", () => {
    const output = view(
      failed(
        "project add",
        new ProjectRegistrationConflictError({
          code: "project-registration-conflict",
          existingAnchor: "/a/.git",
          existingRoots: ["/a"],
          observedAnchor: "/b/.git",
          observedRoots: ["/b"],
          projectName: "demo",
        }),
      ),
    );
    expect(hintsIn(output)).toEqual([]);
  });

  it.effect("an unregistered choice project names project", () =>
    Effect.gen(function* () {
      const output = view(
        failed(
          "pick include",
          new ChoiceProjectNotFoundError({ code: "choice-project-not-found", projectName: "nope" }),
        ),
      );
      expect(output).toContain('Project "nope" is not registered.');
      expect(yield* parseHintsIn(output)).toEqual(["project"]);
    }),
  );

  it("a removing project is a domain failure without a hint", () => {
    const output = view(
      failed(
        "pick remove",
        new ChoiceProjectRemovingError({ code: "choice-project-removing", projectName: "demo" }),
      ),
    );
    expect(lines(output)[0]).toBe("tack pick remove · ✗ domain");
    expect(hintsIn(output)).toEqual([]);
  });

  it("an invalid adapter selection renders the diagnostics only", () => {
    const output = view(
      failed(
        "adapter enable",
        new AgentSelectionValidationError({
          code: "enabled-adapters-invalid",
          message: "Adapter IDs must be unique.",
        }),
      ),
    );
    expect(lines(output)[0]).toBe("tack adapter enable · ✗ invalid-invocation");
    expect(output).toContain("Adapter IDs must be unique.");
  });

  it.effect("an unavailable docs resource names the catalog", () =>
    Effect.gen(function* () {
      const output = view(
        failed(
          "docs attach",
          new DocsError({
            code: "docs-resource-unavailable",
            message: "Choose a healthy declared docs resource from tack catalog.",
            details: { resource: handbook },
          }),
        ),
      );
      expect(lines(output)[0]).toBe("tack docs attach · ✗ domain");
      expect(output).toContain("docs-resource-unavailable");
      expect(yield* parseHintsIn(output)).toEqual(["catalog"]);
    }),
  );
});

describe("layout", () => {
  const longPath = `/home/me/${"プロジェクト".repeat(4)}/${"segment-".repeat(10)}source`;
  const envelopes = {
    "source add": applied("source add", {
      ...({
        alreadyRegistered: false,
        docs: [{ name: "handbook-with-a-rather-long-name" }],
        registration: { canonicalPath: longPath, id: registrationId },
      } satisfies SourceMutationResult),
      // A source without a label: the confirmation names it by its long path alone.
      name: registrationId,
    }),
    "pick include": choiceSet(true, typo),
    "project add": applied("project add", {
      alreadyRegistered: false,
      project: {
        gitCommonDirectory: `${longPath}/.git`,
        name: "long-project",
        roots: [longPath, `${longPath}-wt`],
      },
      handMade: [
        {
          adapter: "claude",
          kind: "skill",
          path: `${longPath}/.claude/skills/a-hand-made-skill-with-a-long-name`,
          entry: "symlink",
        },
      ],
    } satisfies RegisterProjectResult),
    "docs attach": applied("docs attach", {
      attachments: [handbook, notes],
      destination: "knowledge/ドキュメント",
      projectName: "demo",
    } satisfies DocsProject),
    "adapter enable": applied("adapter enable", {
      changed: true,
      enabledAdapters: ["claude", "codex", "cursor"],
    } satisfies SetEnabledAdaptersResult),
  } as const;

  it("holds long and wide-character values to the view contract", () => {
    for (const envelope of Object.values(envelopes)) expectViewContract(envelope, terminal);
  });

  it("keeps long values whole on their own lines at width 40", () => {
    const output = view(envelopes["source add"], 40);
    expect(lines(output)).toContain(`~${longPath.slice("/home/me".length)}.`);
    expect(lines(output)).toContain(`    ${registrationId}`);
  });
});

describe("undecodable payloads", () => {
  it("returns undefined so the generic view is used", () => {
    for (const command of Object.keys(mutationViews)) {
      const envelope = createPublicEnvelope(command, appliedOutcome({ unexpected: true }));
      expect(mutationViews[command]?.(envelope, style())).toBeUndefined();
      expect(renderHuman(envelope, style())).toContain(`tack ${command}`);
      const empty = createPublicEnvelope(command, { classification: "success", diagnostics: [] });
      expect(mutationViews[command]?.(empty, style())).toBeUndefined();
    }
  });

  it("registers exactly the immediate mutations", () => {
    expect(Object.keys(mutationViews).toSorted()).toEqual([
      "adapter enable",
      "docs attach",
      "docs configure",
      "docs detach",
      "pick exclude",
      "pick include",
      "pick remove",
      "project add",
      "source add",
      "source relocate",
      "state init",
    ]);
  });
});
