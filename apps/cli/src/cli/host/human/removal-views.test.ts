import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { posix } from "node:path";
import { outcomeForError } from "../errors.ts";
import {
  envelopeOf,
  expectViewContract,
  flat,
  hintRecorder,
  humanFixture,
  lines,
  plainStyle,
  renderView,
  styleOf,
} from "./human.test-support.ts";
import { docsSummary, removalScopeBlock, removalScopeText } from "./removal-rows.ts";
import { removalViews } from "./removal-views.ts";
import { nextCommandsOf } from "./render.ts";
import { renderSync } from "./sync.ts";
import { previewOutcome, removalOutcome, syncOutcome } from "../outcomes.ts";
import { createPublicEnvelope, type PublicEnvelope } from "../public-outcome.ts";
import {
  DocsLinkApplicationSchema,
  DocsLinkReportSchema,
  type DocsLinkAction,
  type DocsLinkApplication,
  type DocsLinkOutcome,
  type DocsManagedLink,
  type ReportedDocsManagedLink,
} from "../../../domain/docs/docs-schema.ts";
import {
  AdapterDisablementPlanSchema,
  AdapterDisablementResultSchema,
  type AdapterDisablementPlan,
  type AdapterDisablementResult,
} from "../../../features/maintenance/adapter-disablement.ts";
import {
  SourceRemovalPlanSchema,
  SourceRemovalResultSchema,
  type SourceRemovalPlan,
} from "../../../features/maintenance/source-removal.ts";
import {
  ProjectRemovalPlanSchema,
  ProjectRemovalResultSchema,
  type ProjectRemovalPlan,
} from "../../../features/maintenance/project-removal.ts";
import {
  ProjectRefreshCommandPlanSchema,
  ProjectRefreshCommandResultSchema,
  type ProjectRefreshCommandPlan,
  type ProjectRefreshCommandResult,
} from "../../../features/refresh/project-refresh-schema.ts";
import { destinationObservationMessage } from "../../../features/links/managed-link-ownership.ts";
import {
  RemovalPlanSchema,
  RemovalProjectNotFoundError,
  RemovalResultSchema,
  type RemovalAction,
  type RemovalActionOutcome,
  type RemovalPlan,
  type RemovalResult,
  type RemovalScope,
} from "../../../domain/reconciliation/removal-schema.ts";
import { managedLinkDestinationPath } from "../../../domain/agents/agent-layout.ts";
import {
  managedLinkDestinationIdentity,
  type ManagedLinkEvidence,
} from "../../../domain/links/managed-link-schema.ts";
import { compareCodeUnits } from "../../../domain/identity/ordering.ts";
import type { ReportedPendingRemoval as PendingRemoval } from "../../../domain/links/pending-removal-schema.ts";
import { hintsIn, parseHintsIn } from "../../../../test/support/hints.ts";

// Rendering helpers

const render = (envelope: PublicEnvelope, width = 80) => renderView(envelope, { width });

// Fixtures: values typed by the production schemas and validated by them

const sourceRegistrationId = "00000000-0000-4000-8000-000000000001";
const demoRoot = {
  _tag: "project-root",
  canonicalPath: "/home/me/demo",
  projectName: "demo",
} as const;
const userTarget = { _tag: "user", canonicalPath: "/home/me" } as const;

const evidence = (
  name: string,
  target: ManagedLinkEvidence["target"] = demoRoot,
  adapter: ManagedLinkEvidence["adapter"] = "claude",
): ManagedLinkEvidence => ({
  adapter,
  address: { kind: "skill", name, sourceRegistrationId },
  sourceDirectoryPath: `/home/me/skills/${name}`,
  sourceRegistrationId,
  target,
});

type RemoveAction = Extract<RemovalAction, { readonly _tag: "remove" }>;
type RetireAction = Extract<RemovalAction, { readonly _tag: "retire" }>;

const removeOf = (item: ManagedLinkEvidence): RemoveAction => ({
  _tag: "remove",
  destinationPath: managedLinkDestinationPath(item),
  evidence: item,
});
const retireOf = (item: ManagedLinkEvidence): RetireAction => ({
  _tag: "retire",
  destinationPath: managedLinkDestinationPath(item),
  evidence: item,
});
const blockedOf = (item: ManagedLinkEvidence): RemovalAction => {
  const destinationPath = managedLinkDestinationPath(item);
  return {
    _tag: "blocked",
    destinationPath,
    evidence: item,
    message: destinationObservationMessage({
      _tag: "entry",
      destinationPath,
      entryType: "directory",
    }),
    observation: { _tag: "entry", destinationPath, entryType: "directory" },
  };
};

const pendingOf = (
  item: ManagedLinkEvidence,
  cause: PendingRemoval["cause"],
  lastResult?: PendingRemoval["lastResult"],
): PendingRemoval => ({
  cause,
  destinationPath: managedLinkDestinationPath(item),
  evidence: item,
  ...(lastResult === undefined ? {} : { lastResult }),
});

const removalPlan = (
  scope: RemovalScope,
  actions: ReadonlyArray<RemovalAction>,
  extra: Partial<Pick<RemovalPlan, "cause" | "docsActions" | "expectedPendingRemovals">> & {
    readonly finalizeProject?: boolean;
  } = {},
): RemovalPlan => {
  const sorted = [...actions].sort((left, right) =>
    compareCodeUnits(left.destinationPath, right.destinationPath),
  );
  const plan: RemovalPlan = {
    actions: sorted,
    cause: extra.cause ?? "clean",
    expectedManagedLinks: sorted
      .map((action) => action.evidence)
      .sort((left, right) =>
        compareCodeUnits(
          managedLinkDestinationIdentity(left),
          managedLinkDestinationIdentity(right),
        ),
      ),
    expectedPendingRemovals: extra.expectedPendingRemovals ?? [],
    ...(extra.docsActions === undefined ? {} : { docsActions: extra.docsActions }),
    finalizeProject: extra.finalizeProject ?? false,
    kind: "managed-removal-plan",
    scope,
    version: 1,
  };
  return Schema.decodeUnknownSync(RemovalPlanSchema)(plan);
};

const appliedOutcomeOf = (action: RemovalAction): RemovalActionOutcome =>
  action._tag === "blocked"
    ? { _tag: "skipped", action, reason: action.message }
    : { _tag: "applied", action };

const removalResult = (
  actions: ReadonlyArray<RemovalActionOutcome>,
  extra: Partial<Pick<RemovalResult, "docsActions" | "pending">> & {
    readonly finalizedProject?: boolean;
  } = {},
): RemovalResult =>
  Schema.decodeUnknownSync(RemovalResultSchema)({
    actions,
    ...(extra.docsActions === undefined ? {} : { docsActions: extra.docsActions }),
    finalizedProject: extra.finalizedProject ?? false,
    kind: "managed-removal-application",
    pending: extra.pending ?? [],
    version: 1,
  });

const planned = (plan: RemovalPlan) => [plan];

/** The envelope a cleanup route produces, built by the production outcome builder. */
const cleanupEnvelope = (
  command: "clean" | "reset" | "retry",
  plan: RemovalPlan,
  applied?: RemovalResult,
  selection?: object,
) =>
  createPublicEnvelope(
    command === "reset" ? "state reset" : "state clean",
    removalOutcome(
      {
        plan: selection === undefined ? plan : { ...plan, selection },
        ...(applied === undefined ? {} : { applied }),
      },
      { planned: planned(plan), applied: applied === undefined ? undefined : [applied] },
    ),
  );

const projectSelection = {
  selector: { _tag: "project", projectName: "demo" },
  targets: [demoRoot],
};
const bareSelection = {
  containingRoot: { projectName: "demo", root: "/home/me/demo" },
  selector: { _tag: "bare" },
  targets: [demoRoot],
};
const userSelection = { selector: { _tag: "user" }, targets: [userTarget] };

const review = evidence("review");
const notes = evidence("notes");
const stale = evidence("stale");
const foreign = evidence("foreign");

const mixedPlan = removalPlan({ _tag: "selected-targets", targets: [demoRoot] }, [
  removeOf(review),
  retireOf(stale),
  blockedOf(foreign),
]);

/**
 * Rows with indentation and column padding collapsed. The lines a row wrapped or stacked onto, and
 * the notes under it, are indented deeper than the row and are joined onto it, so an assertion does
 * not depend on where a row wrapped. A token broken at `/ - _` joins back without a space.
 */
const rowsOf = (output: string) =>
  lines(output).reduce<Array<string>>((rows, line) => {
    const text = line.trim().replace(/\s+/g, " ");
    const previous = rows.at(-1);
    if (/^ {4}/.test(line) && previous !== undefined)
      rows[rows.length - 1] = /[/_-]$/.test(previous)
        ? `${previous}${text}`
        : `${previous} ${text}`;
    else rows.push(text);
    return rows;
  }, []);

/** Asserts a row that starts with `expected`, however its detail wrapped. */
const expectRow = (output: string, expected: string) =>
  expect(rowsOf(output).some((row) => row.startsWith(expected))).toBe(true);

/** The statement block that follows the header, with its wrapped lines joined. */
const statementOf = (output: string) =>
  (output.split("\n\n")[1] ?? "").trim().split("\n").join(" ");

const operationsOf = (output: string) => Effect.runPromise(parseHintsIn(output));

// clean

describe("clean", () => {
  it.effect("previews every planned action, states nothing was written and hints --apply", () =>
    Effect.gen(function* () {
      const output = render(cleanupEnvelope("clean", mixedPlan, undefined, projectSelection));
      const rows = lines(output);
      expect(rows[0]).toBe("tack state clean · project demo · ! partial");
      expect(statementOf(output)).toBe(
        "Preview only: nothing was written. 1 to remove, 1 to forget, 1 blocked.",
      );
      expect(rows).toContain("Targets");
      expect(rows).toContain("  project demo  /home/me/demo");
      expect(rows).toContain("Actions");
      expectRow(
        output,
        `! blocked /home/me/demo/.claude/skills/foreign skill ${sourceRegistrationId}:foreign · claude`,
      );
      expect(output).toContain("blocked: The destination is an existing directory.");
      expectRow(
        output,
        `− remove /home/me/demo/.claude/skills/review skill ${sourceRegistrationId}:review · claude`,
      );
      expectRow(
        output,
        `· forget /home/me/demo/.claude/skills/stale skill ${sourceRegistrationId}:stale · claude`,
      );
      expect(hintsIn(output)).toEqual([
        "tack state clean --project demo --apply",
        "tack status --project demo",
      ]);
      expect(yield* parseHintsIn(output)).toEqual(["state clean", "status"]);
    }),
  );

  it("reproduces user and bare selectors in the apply hint", async () => {
    const user = removalPlan({ _tag: "selected-targets", targets: [userTarget] }, [
      removeOf(evidence("review", userTarget)),
    ]);
    expect(hintsIn(render(cleanupEnvelope("clean", user, undefined, userSelection)))).toEqual([
      "tack state clean --user --apply",
    ]);
    const bare = removalPlan({ _tag: "selected-targets", targets: [demoRoot] }, [removeOf(review)]);
    const output = render(cleanupEnvelope("clean", bare, undefined, bareSelection));
    expect(hintsIn(output)).toEqual(["tack state clean --cwd /home/me/demo --apply"]);
    expect(await operationsOf(output)).toEqual(["state clean"]);
    expect(lines(output)[0]).toBe("tack state clean · project demo · ✓ success");
    expect(lines(output)).toContain("  selected from the containing root /home/me/demo");
    expect(output).not.toContain("skill review · claude · user");
  });

  it("names machine-wide clean scope and preserves --all in its hint", () => {
    const plan = removalPlan({ _tag: "selected-targets", targets: [demoRoot, userTarget] }, [
      removeOf(review),
      removeOf(evidence("review", userTarget)),
    ]);
    const output = render(
      cleanupEnvelope("clean", plan, undefined, {
        selector: { _tag: "all" },
        targets: [demoRoot, userTarget],
      }),
    );
    expect(lines(output)[0]).toBe("tack state clean · all projects and user · ✓ success");
    expect(hintsIn(output)).toContain("tack state clean --all --apply");
  });

  it.effect("applies with per-action outcomes, retained obligations and retry hints", () =>
    Effect.gen(function* () {
      const failing = removeOf(notes);
      const plan = removalPlan({ _tag: "selected-targets", targets: [demoRoot] }, [
        removeOf(review),
        retireOf(stale),
        failing,
        blockedOf(foreign),
      ]);
      const result = removalResult(
        [
          { _tag: "applied", action: removeOf(review) },
          { _tag: "applied", action: retireOf(stale) },
          {
            _tag: "failed",
            action: failing,
            code: "filesystem-failure",
            message: "EACCES: permission denied",
          },
          appliedOutcomeOf(blockedOf(foreign)),
        ],
        {
          pending: [
            pendingOf(notes, "clean", {
              _tag: "filesystem-failure",
              message: "EACCES: permission denied",
            }),
            pendingOf(foreign, "clean", {
              _tag: "blocked",
              message: "The destination is an existing directory.",
            }),
          ].sort((a, b) => compareCodeUnits(a.destinationPath, b.destinationPath)),
        },
      );
      const envelope = cleanupEnvelope("clean", plan, result, projectSelection);
      expect(envelope.status).toBe("partial");
      // Wide enough that every action row fits on one line, so each reads back whole.
      const output = render(envelope, 120);
      const rows = lines(output);
      expect(rows[0]).toBe("tack state clean · project demo · ! partial");
      expect(statementOf(output)).toBe(
        "Applied: 1 removed, 1 forgotten, 1 failed, 1 skipped, 2 cleanup obligations still pending.",
      );
      expectRow(
        output,
        `✓ applied remove /home/me/demo/.claude/skills/review skill ${sourceRegistrationId}:review · claude`,
      );
      expectRow(
        output,
        `✓ applied forget /home/me/demo/.claude/skills/stale skill ${sourceRegistrationId}:stale · claude`,
      );
      expect(output).toContain("failed (filesystem-failure): EACCES: permission denied");
      expect(output).toContain("skipped: The destination is an existing directory.");
      expect(rows).toContain("Pending cleanup");
      expect(output).toContain("last attempt blocked: The destination is an existing directory.");
      expect(output).toContain("removal-failed · /home/me/demo/.claude/skills/notes");
      expect(hintsIn(output)).toEqual(["tack state clean --pending --project demo"]);
      expect(yield* parseHintsIn(output)).toEqual(["state clean"]);
    }),
  );

  it("applies cleanly with no hint", () => {
    const plan = removalPlan({ _tag: "selected-targets", targets: [demoRoot] }, [removeOf(review)]);
    const output = render(
      cleanupEnvelope(
        "clean",
        plan,
        removalResult([{ _tag: "applied", action: removeOf(review) }]),
        projectSelection,
      ),
    );
    expect(statementOf(output)).toBe("Applied: 1 removed.");
    expect(hintsIn(output)).toEqual([]);
  });

  it("states there is nothing to remove, with no hint", () => {
    const plan = removalPlan({ _tag: "selected-targets", targets: [demoRoot] }, []);
    const preview = render(cleanupEnvelope("clean", plan, undefined, projectSelection));
    expect(statementOf(preview)).toBe("Preview only: nothing was written. Nothing to remove.");
    expect(hintsIn(preview)).toEqual([]);
    const applied = render(cleanupEnvelope("clean", plan, removalResult([]), projectSelection));
    expect(statementOf(applied)).toBe("Applied. Nothing to remove.");
  });

  it("lists docs links the cleanup removes", () => {
    const docs = docsLink("demo", "/home/me/demo");
    const plan = removalPlan(
      { _tag: "selected-targets", targets: [demoRoot] },
      [removeOf(review)],
      { docsActions: [{ action: "remove", evidence: docs }] },
    );
    const preview = render(cleanupEnvelope("clean", plan, undefined, projectSelection));
    expect(lines(preview)).toContain("Docs links");
    expectRow(
      preview,
      `− remove /home/me/demo/docs/guide docs ${sourceRegistrationId}:guide · project demo`,
    );
    expect(preview).toContain("1 docs link to remove");
    const applied = render(
      cleanupEnvelope(
        "clean",
        plan,
        removalResult([{ _tag: "applied", action: removeOf(review) }], {
          docsActions: [{ _tag: "applied", action: { action: "remove", evidence: docs } }],
        }),
        projectSelection,
      ),
    );
    expect(applied).toContain("1 docs link removed");
    expectRow(
      applied,
      `✓ applied remove /home/me/demo/docs/guide docs ${sourceRegistrationId}:guide · project demo`,
    );
  });

  it("previews a docs link apply would refuse as a conflict, with no apply hint", () => {
    const plan = removalPlan({ _tag: "selected-targets", targets: [demoRoot] }, [], {
      docsActions: [
        {
          action: "conflict",
          code: "docs-destination-modified",
          evidence: docsLink("demo", "/home/me/demo"),
          message:
            "The recorded destination was changed; ownership does not authorize removing it.",
        },
      ],
    });
    const preview = render(cleanupEnvelope("clean", plan, undefined, projectSelection));
    expectRow(
      preview,
      `! conflict /home/me/demo/docs/guide docs ${sourceRegistrationId}:guide · project demo`,
    );
    expect(flat(preview)).toContain(
      "conflict: The recorded destination was changed; ownership does not authorize removing it.",
    );
    expect(statementOf(preview)).toBe("Preview only: nothing was written. 1 docs conflict.");
    expect(hintsIn(preview)).toEqual([]);
  });

  it.effect("renders a failure with its diagnostic and the command it names", () =>
    Effect.gen(function* () {
      const envelope = createPublicEnvelope(
        "state clean",
        outcomeForError(new RemovalProjectNotFoundError({ projectName: "nope" })),
      );
      expect(envelope.status).toBe("failure");
      const output = render(envelope);
      const rows = lines(output);
      expect(rows[0]).toBe("tack state clean · ✗ invalid-configuration");
      expect(output).toContain('Project "nope" is not registered.');
      expect(hintsIn(output)).toEqual(["tack project"]);
      expect(yield* parseHintsIn(output)).toEqual(["project"]);
    }),
  );

  it("keeps the view contract with long and wide-character paths", () => {
    const wideRoot = {
      _tag: "project-root",
      canonicalPath: "/home/me/代码/非常长的项目目录名称/demo-with-a-long-checkout-name",
      projectName: "demo",
    } as const;
    const wide = evidence("review", wideRoot);
    const plan = removalPlan({ _tag: "selected-targets", targets: [wideRoot] }, [
      removeOf(wide),
      blockedOf(evidence("foreign", wideRoot)),
    ]);
    expectViewContract(cleanupEnvelope("clean", plan, undefined, projectSelection));
    for (const width of [40, 80, 120]) {
      const output = render(cleanupEnvelope("clean", plan, undefined, projectSelection), width);
      expect(output).toContain("非常长的项目目录名称");
      expect(rowsOf(output).join(" ")).toContain(
        "blocked: The destination is an existing directory.",
      );
    }
    const narrow = render(cleanupEnvelope("clean", plan, undefined, projectSelection), 40);
    expect(lines(narrow)).toEqual(
      expect.arrayContaining([
        "  − remove",
        "    /home/me/代码/非常长的项目目录名称/",
        "    demo-with-a-long-checkout-name/",
        "    .claude/skills/review",
      ]),
    );
  });
});

// retry

describe("retry", () => {
  it.effect("previews pending obligations of a bare selector and reproduces it", () =>
    Effect.gen(function* () {
      const goneRoot = {
        _tag: "project-root",
        canonicalPath: "/home/me/gone",
        projectName: "gone",
      } as const;
      const pending = evidence("old", goneRoot);
      const plan = removalPlan({ _tag: "maintenance" }, [removeOf(pending)], {
        cause: "clean",
        expectedPendingRemovals: [
          pendingOf(pending, "project-removal", {
            _tag: "blocked",
            message: "The destination is an existing file.",
          }),
        ],
        finalizeProject: true,
      });
      const output = render(cleanupEnvelope("retry", plan, undefined, bareSelection));
      const rows = lines(output);
      expect(rows[0]).toBe("tack state clean · project demo · ✓ success");
      expect(statementOf(output)).toBe("Preview only: nothing was written. 1 to remove.");
      expect(rowsOf(output).join(" ")).toContain(
        `skill ${sourceRegistrationId}:old · claude · pending (project-removal)`,
      );
      expect(output).toContain("last attempt blocked: The destination is an existing file.");
      expect(hintsIn(output)).toEqual(["tack state clean --pending --cwd /home/me/demo --apply"]);
      expect(yield* parseHintsIn(output)).toEqual(["state clean"]);
    }),
  );

  it.effect("reports a still-blocked application with the same retry command", () =>
    Effect.gen(function* () {
      const plan = removalPlan({ _tag: "retry-targets", targets: [userTarget] }, [
        removeOf(evidence("review", userTarget)),
      ]);
      const failed: RemovalActionOutcome = {
        _tag: "failed",
        action: removeOf(evidence("review", userTarget)),
        code: "filesystem-failure",
        message: "EBUSY",
      };
      const output = render(
        cleanupEnvelope(
          "retry",
          plan,
          removalResult([failed], {
            pending: [pendingOf(evidence("review", userTarget), "clean")],
          }),
          userSelection,
        ),
      );
      expect(lines(output)[0]).toBe("tack state clean · user · ! partial");
      expect(hintsIn(output)).toEqual(["tack state clean --pending --user"]);
      expect(yield* parseHintsIn(output)).toEqual(["state clean"]);
    }),
  );
});

// reset

describe("reset", () => {
  const managed = [
    removeOf(review),
    removeOf(evidence("review", userTarget, "codex")),
    retireOf(stale),
  ];
  const resetPlan = removalPlan({ _tag: "reset" }, managed, {
    cause: "reset",
    expectedPendingRemovals: [
      pendingOf(stale, "clean", { _tag: "interrupted", message: "Cleanup was interrupted." }),
    ],
  });

  it.effect("lists every managed link and pending removal and states nothing was written", () =>
    Effect.gen(function* () {
      const output = render(cleanupEnvelope("reset", resetPlan));
      const rows = lines(output);
      expect(rows[0]).toBe("tack state reset · all managed state · ✓ success");
      expect(statementOf(output)).toBe(
        "Preview only: nothing was written. 2 to remove, 1 to forget.",
      );
      expect(rows.filter((row) => /^ {2}[−·] (remove|forget)/.test(row)).length).toBe(3);
      expect(rows).toContain("claude → demo · 1 to remove, 1 to forget");
      expect(rows).toContain("codex → user · 1 to remove");
      expect(output).toContain("/home/me/.agents/skills/review");
      expect(rowsOf(output).join(" ")).toContain(
        `skill ${sourceRegistrationId}:stale · claude · project demo · pending (clean)`,
      );
      expect(output).toContain("last attempt interrupted: Cleanup was interrupted.");
      expect(hintsIn(output)).toEqual(["tack state reset --apply"]);
      expect(yield* parseHintsIn(output)).toEqual(["state reset"]);
    }),
  );

  it("states Tack state was deleted after a clean application", () => {
    const output = render(
      cleanupEnvelope(
        "reset",
        resetPlan,
        removalResult([
          { _tag: "applied", action: removeOf(review) },
          { _tag: "applied", action: removeOf(evidence("review", userTarget, "codex")) },
          { _tag: "applied", action: retireOf(stale) },
        ]),
      ),
    );
    expect(statementOf(output)).toBe("Applied: 2 removed, 1 forgotten, Tack state deleted.");
    expect(hintsIn(output)).toEqual([]);
  });

  it("keeps the view contract", () => {
    expectViewContract(cleanupEnvelope("reset", resetPlan));
  });

  it.effect("keeps the state and hints reset --apply when an action did not settle", () =>
    Effect.gen(function* () {
      const output = render(
        cleanupEnvelope(
          "reset",
          resetPlan,
          removalResult(
            [
              { _tag: "applied", action: removeOf(review) },
              {
                _tag: "skipped",
                action: removeOf(evidence("review", userTarget, "codex")),
                reason: "The destination is absolute-link.",
              },
              { _tag: "applied", action: retireOf(stale) },
            ],
            { pending: [pendingOf(evidence("review", userTarget, "codex"), "reset")] },
          ),
        ),
      );
      expect(output).not.toContain("Tack state deleted");
      expect(output).toContain("1 cleanup obligation still pending");
      expect(hintsIn(output)).toEqual(["tack state reset --apply"]);
      expect(yield* parseHintsIn(output)).toEqual(["state reset"]);
    }),
  );
});

// adapter disable

const adapterPlan = (
  removal: RemovalPlan,
  enabled: AdapterDisablementPlan["expectedEnabledAdapters"] = ["claude", "codex", "cursor"],
): AdapterDisablementPlan =>
  Schema.decodeUnknownSync(AdapterDisablementPlanSchema)({
    adapter: "cursor",
    enabledAdapters: enabled.filter((adapter) => adapter !== "cursor"),
    expectedEnabledAdapters: enabled,
    kind: "adapter-disablement-plan",
    removal,
    version: 1,
  });

const adapterResult = (removal: RemovalResult): AdapterDisablementResult =>
  Schema.decodeUnknownSync(AdapterDisablementResultSchema)({
    adapter: "cursor",
    enabledAdapters: ["claude", "codex"],
    kind: "adapter-disablement-application",
    removal,
    version: 1,
  });

const adapterEnvelope = (plan: AdapterDisablementPlan, applied?: AdapterDisablementResult) =>
  createPublicEnvelope(
    "adapter disable",
    removalOutcome(
      { plan, ...(applied === undefined ? {} : { applied }) },
      { planned: [plan.removal], applied: applied === undefined ? undefined : [applied.removal] },
    ),
  );

describe("adapter disable", () => {
  const cursorLink = evidence("review", demoRoot, "cursor");
  const removal = removalPlan({ _tag: "adapter", adapter: "cursor" }, [removeOf(cursorLink)], {
    cause: "adapter-disable",
  });

  it.effect("previews the setting change and the cleanup", () =>
    Effect.gen(function* () {
      const output = render(adapterEnvelope(adapterPlan(removal)));
      const rows = lines(output);
      expect(rows[0]).toBe("tack adapter disable · adapter cursor · ✓ success");
      expect(statementOf(output)).toBe("Preview only: nothing was written. 1 to remove.");
      expect(rows).toContain("Enabled adapters  claude, codex, cursor → claude, codex");
      expect(output).toContain("/home/me/demo/.cursor/skills/review");
      expect(hintsIn(output)).toEqual(["tack adapter disable cursor --apply"]);
      expect(yield* parseHintsIn(output)).toEqual(["adapter disable"]);
    }),
  );

  it("says when the adapter is not enabled and there is nothing to remove", () => {
    const empty = removalPlan({ _tag: "adapter", adapter: "cursor" }, [], {
      cause: "adapter-disable",
    });
    const output = render(adapterEnvelope(adapterPlan(empty, ["claude"])));
    expect(lines(output)).toContain("Enabled adapters  claude (cursor is not enabled)");
    expect(statementOf(output)).toBe("Preview only: nothing was written. Nothing to remove.");
    expect(hintsIn(output)).toEqual([]);
    expect(lines(render(adapterEnvelope(adapterPlan(empty, []))))).toContain(
      "Enabled adapters  none (cursor is not enabled)",
    );
  });

  it.effect("applies partially, retaining the obligation with a retry hint", () =>
    Effect.gen(function* () {
      const result = removalResult(
        [
          {
            _tag: "failed",
            action: removeOf(cursorLink),
            code: "filesystem-failure",
            message: "EIO: i/o error",
          },
        ],
        {
          pending: [
            pendingOf(cursorLink, "adapter-disable", {
              _tag: "filesystem-failure",
              message: "EIO: i/o error",
            }),
          ],
        },
      );
      const envelope = adapterEnvelope(adapterPlan(removal), adapterResult(result));
      expect(envelope.status).toBe("partial");
      const output = render(envelope);
      expect(lines(output)).toContain("Enabled adapters  now claude, codex");
      expect(statementOf(output)).toBe("Applied: 1 failed, 1 cleanup obligation still pending.");
      expect(output).toContain("failed (filesystem-failure): EIO: i/o error");
      expect(hintsIn(output)).toEqual(["tack state clean --pending --project demo"]);
      expect(yield* parseHintsIn(output)).toEqual(["state clean"]);
    }),
  );

  it("keeps the view contract", () => {
    expectViewContract(adapterEnvelope(adapterPlan(removal)));
  });

  // The user target and project demo through two roots: 2 + 6 + 6 = 14 actions, over the cap.
  const demoWorktree = {
    _tag: "project-root",
    canonicalPath: "/home/me/demo-fix",
    projectName: "demo",
  } as const;
  const skillNames = ["a1", "a2", "a3", "a4", "a5", "a6"];
  const wideActions = [
    ...["u1", "u2"].map((name) => removeOf(evidence(name, userTarget, "cursor"))),
    ...skillNames.map((name) => removeOf(evidence(name, demoRoot, "cursor"))),
    ...skillNames.map((name) => removeOf(evidence(name, demoWorktree, "cursor"))),
  ];
  const wide = removalPlan({ _tag: "adapter", adapter: "cursor" }, wideActions, {
    cause: "adapter-disable",
  });
  const actionRowsOf = (output: string) =>
    rowsOf(output).filter((row) => /^[−·!✓✗] (remove|forget|blocked|applied|failed)/.test(row));

  it("states the scope and sums the removals per target in the words of sync", () => {
    const output = render(adapterEnvelope(adapterPlan(wide)));
    const rows = lines(output);
    expect(rows).toContain("Scope  every project and the user target");
    expect(rows).toContain("cursor → user · 2 to remove");
    expect(rows).toContain("cursor → demo (2 roots) · 12 to remove");
    expect(rows.indexOf("cursor → user · 2 to remove")).toBeLessThan(rows.indexOf("Actions"));
  });

  it("lists the first 10 actions, the rest only with --details", () => {
    const output = render(adapterEnvelope(adapterPlan(wide)));
    expect(actionRowsOf(output)).toHaveLength(10);
    expect(lines(output)).toContain("  4 more; use --details");
    const detailed = renderView(adapterEnvelope(adapterPlan(wide)), { details: true });
    expect(actionRowsOf(detailed)).toHaveLength(14);
    expect(detailed).not.toContain("more; use --details");
  });

  it("lists actions that need attention before the cap hides them", () => {
    const withBlocked = removalPlan(
      { _tag: "adapter", adapter: "cursor" },
      [...wideActions, blockedOf(evidence("zz", demoRoot, "cursor"))],
      { cause: "adapter-disable" },
    );
    const output = render(adapterEnvelope(adapterPlan(withBlocked)));
    expect(actionRowsOf(output)[0]).toMatch(/^! blocked/);
    expect(lines(output)).toContain("cursor → demo (2 roots) · 12 to remove, 1 blocked");
  });

  it.effect("names status for every target after a successful apply, in text and JSON", () =>
    Effect.gen(function* () {
      const envelope = adapterEnvelope(
        adapterPlan(wide),
        adapterResult(removalResult(wideActions.map(appliedOutcomeOf))),
      );
      const output = render(envelope);
      expect(lines(output)).toContain("cursor → user · 2 removed");
      expect(lines(output)).toContain("cursor → demo (2 roots) · 12 removed");
      expect(hintsIn(output)).toEqual(["tack status --all"]);
      expect(yield* parseHintsIn(output)).toEqual(["status"]);
      expect(nextCommandsOf(envelope, plainStyle)).toEqual(["tack status --all"]);
    }),
  );

  it("keeps the view contract with many targets, capped and detailed", () => {
    expectViewContract(adapterEnvelope(adapterPlan(wide)));
    expectViewContract(adapterEnvelope(adapterPlan(wide)), { details: true });
  });
});

// source remove, project remove

const reviewAddress = { kind: "skill", name: "review", sourceRegistrationId } as const;
const projectPick = {
  address: reviewAddress,
  decision: "include",
  namespace: { _tag: "project", projectName: "demo" },
} as const;
const guideAttachment = {
  projectName: "demo",
  sourceRegistrationId,
  name: "guide",
  writingDefault: true,
} as const;
const notesAttachment = { projectName: "demo", sourceRegistrationId, name: "notes" } as const;

/** The envelope a registration removal route produces, built by the production outcome builder. */
const registrationEnvelope = (
  command: "source remove" | "project remove",
  plan: { readonly removal: RemovalPlan },
  applied?: { readonly removal: RemovalResult },
) =>
  createPublicEnvelope(
    command,
    removalOutcome(
      { plan, ...(applied === undefined ? {} : { applied }) },
      { planned: [plan.removal], applied: applied === undefined ? undefined : [applied.removal] },
    ),
  );

describe("source remove", () => {
  const sourceScope = { _tag: "source", sourceRegistrationId } as const;
  const sourcePlan = (
    actions: ReadonlyArray<RemovalAction>,
    extra: Partial<SourceRemovalPlan> = {},
  ): SourceRemovalPlan =>
    Schema.decodeUnknownSync(SourceRemovalPlanSchema)({
      kind: "source-removal-plan",
      version: 1,
      source: { id: sourceRegistrationId, canonicalPath: "/home/me/sources/brain", label: "brain" },
      removal: removalPlan(sourceScope, actions),
      picks: [{ ...projectPick, namespace: { _tag: "user" } }, projectPick],
      docsAttachments: [guideAttachment],
      profileApplications: [
        {
          namespace: { _tag: "project", projectName: "demo" },
          profileName: "ci",
          sourceRegistrationId,
          outcome: "dropped",
          members: [reviewAddress],
        },
        {
          namespace: { _tag: "user" },
          profileName: "kit",
          sourceRegistrationId: "00000000-0000-4000-8000-000000000002",
          outcome: "unresolved",
          members: [reviewAddress],
        },
      ],
      dependants: [
        {
          sourceRegistrationId: "00000000-0000-4000-8000-000000000002",
          label: "tools",
          reason: "depends-on",
        },
        { sourceRegistrationId: "00000000-0000-4000-8000-000000000003", reason: "bundle-binding" },
      ],
      ...extra,
    });

  it.effect("previews the cleanup, the intent it deletes and what it leaves dangling", () =>
    Effect.gen(function* () {
      const output = render(registrationEnvelope("source remove", sourcePlan([removeOf(review)])));
      expect(lines(output)[0]).toBe("tack source remove · source brain · ✓ success");
      expect(statementOf(output)).toBe(
        "Preview only: nothing was written. 1 to remove, 2 picks to delete, 1 docs attachment to detach, 1 source registration to remove. Add --apply to remove the source.",
      );
      expectRow(output, "Source brain /home/me/sources/brain");
      expectRow(output, "user skill review include");
      expectRow(output, "project demo skill review include");
      expectRow(output, "project demo guide writing default");
      expectRow(
        output,
        "− drop project demo ci returns to daily selection on its next sync, which can deliver other resources",
      );
      expectRow(output, "! keep user kit members that no longer resolve: review");
      expectRow(
        output,
        "! tools declares this source in depends-on its resources that require a resource of this source become blocked",
      );
      expectRow(
        output,
        "! 00000000-0000-4000-8000-000000000003 binds this source in its bundle it becomes unhealthy",
      );
      expect(hintsIn(output)).toEqual(["tack source remove brain --apply"]);
      expect(yield* parseHintsIn(output)).toEqual(["source remove"]);
    }),
  );

  it("names a source without a label by its registration ID", () => {
    const plan = sourcePlan([], {
      source: { id: sourceRegistrationId, canonicalPath: "/home/me/sources/gone" },
      picks: [],
      docsAttachments: [],
      profileApplications: [],
      dependants: [],
    });
    const output = render(registrationEnvelope("source remove", plan));
    expect(lines(output)[0]).toBe(
      `tack source remove · source ${sourceRegistrationId} · ✓ success`,
    );
    expect(statementOf(output)).toBe(
      "Preview only: nothing was written. 1 source registration to remove. Add --apply to remove the source.",
    );
    expect(hintsIn(output)).toEqual([`tack source remove ${sourceRegistrationId} --apply`]);
  });

  it.effect("applies with a blocked link left pending and names the retry", () =>
    Effect.gen(function* () {
      const plan = sourcePlan([blockedOf(foreign)]);
      const applied = Schema.decodeUnknownSync(SourceRemovalResultSchema)({
        kind: "source-removal-application",
        version: 1,
        source: plan.source,
        removal: removalResult([appliedOutcomeOf(blockedOf(foreign))], {
          pending: [pendingOf(foreign, "clean", { _tag: "blocked", message: "in the way" })],
        }),
      });
      const envelope = registrationEnvelope("source remove", plan, applied);
      expect(envelope.status).toBe("partial");
      const output = render(envelope);
      expect(statementOf(output)).toContain(
        "2 picks deleted, 1 docs attachment detached, 1 source registration removed.",
      );
      expect(hintsIn(output)).toEqual(["tack state clean --pending --project demo"]);
      expect(yield* parseHintsIn(output)).toEqual(["state clean"]);
    }),
  );

  it("keeps the view contract", () => {
    expectViewContract(registrationEnvelope("source remove", sourcePlan([removeOf(review)])));
  });

  it("states the scope, sums each target and caps the actions unless --details", () => {
    const names = Array.from({ length: 11 }, (_, index) => `s${index}`);
    const plan = sourcePlan([
      ...names.map((name) => removeOf(evidence(name))),
      removeOf(evidence("u1", userTarget, "codex")),
    ]);
    const output = render(registrationEnvelope("source remove", plan));
    const rows = lines(output);
    expect(rows).toContain("Scope  every project and the user target");
    expect(rows).toContain("claude → demo · 11 to remove");
    expect(rows).toContain("codex → user · 1 to remove");
    expect(rows).toContain("  2 more; use --details");
    expect(output).not.toContain("/home/me/demo/.claude/skills/s9");
    const detailed = renderView(registrationEnvelope("source remove", plan), { details: true });
    expect(detailed).not.toContain("more; use --details");
    expect(detailed).toContain("/home/me/demo/.claude/skills/s9");
  });
});

describe("project remove", () => {
  const projectScope = { _tag: "project", projectName: "demo" } as const;
  const projectPlan = (
    actions: ReadonlyArray<RemovalAction>,
    extra: Partial<ProjectRemovalPlan> = {},
  ): ProjectRemovalPlan =>
    Schema.decodeUnknownSync(ProjectRemovalPlanSchema)({
      kind: "project-removal-plan",
      version: 1,
      project: "demo",
      removal: removalPlan(projectScope, actions, {
        cause: "project-removal",
        finalizeProject: true,
      }),
      picks: [projectPick],
      docsAttachments: [notesAttachment],
      profileApplication: {
        namespace: { _tag: "project", projectName: "demo" },
        profileName: "ci",
        sourceRegistrationId,
      },
      ...extra,
    });

  it.effect("previews the cleanup and the project's intent", () =>
    Effect.gen(function* () {
      const output = render(
        registrationEnvelope("project remove", projectPlan([removeOf(review)])),
      );
      expect(lines(output)[0]).toBe("tack project remove · project demo · ✓ success");
      expect(lines(output)).toContain("Scope  every root of project demo");
      expect(lines(output)).toContain("claude → demo · 1 to remove");
      expect(statementOf(output)).toBe(
        "Preview only: nothing was written. 1 to remove, 1 pick to delete, 1 docs attachment to detach.",
      );
      expectRow(output, "project demo skill review include");
      expect(rowsOf(output)).toContain("project demo notes");
      expectRow(output, "Fixed profile application ci, dropped");
      expect(output).toContain(
        "Registration of 1 project demo is removed once all its cleanup settles.",
      );
      expect(hintsIn(output)).toEqual(["tack project remove demo --apply"]);
      expect(yield* parseHintsIn(output)).toEqual(["project remove"]);
    }),
  );

  it("says when the project holds nothing but its registration", () => {
    const plan = projectPlan([], { picks: [], docsAttachments: [] });
    const { profileApplication: _dropped, ...withoutApplication } = plan;
    const output = render(registrationEnvelope("project remove", withoutApplication));
    expect(statementOf(output)).toBe(
      "Preview only: nothing was written. The project holds no links, picks or docs attachments.",
    );
  });

  it("keeps a blocked project and names the second apply", () => {
    const plan = projectPlan([blockedOf(foreign)]);
    const applied = Schema.decodeUnknownSync(ProjectRemovalResultSchema)({
      kind: "project-removal-application",
      version: 1,
      project: "demo",
      removal: removalResult([appliedOutcomeOf(blockedOf(foreign))], {
        pending: [
          pendingOf(foreign, "project-removal", { _tag: "blocked", message: "in the way" }),
        ],
      }),
    });
    const output = render(registrationEnvelope("project remove", plan, applied));
    expect(statementOf(output)).toContain("project kept until its cleanup settles.");
    expect(hintsIn(output)).toEqual(["tack project remove demo --apply"]);
    const finished = Schema.decodeUnknownSync(ProjectRemovalResultSchema)({
      ...applied,
      removal: removalResult([], { finalizedProject: true }),
    });
    const done = render(registrationEnvelope("project remove", projectPlan([]), finished));
    expect(statementOf(done)).toBe(
      "Applied: 1 project registration removed, 1 pick deleted, 1 docs attachment detached.",
    );
    expect(hintsIn(done)).toEqual([]);
  });

  it("keeps the view contract", () => {
    expectViewContract(registrationEnvelope("project remove", projectPlan([removeOf(review)])));
  });
});

// sync

const docsLink = (projectName: string, root: string, name = "guide"): ReportedDocsManagedLink => {
  const destinationPath = `${root}/docs/${name}`;
  const sourceDirectoryPath = `/home/me/sources/docs/${name}`;
  return {
    destinationPath,
    projectName,
    relativeTarget: posix.relative(posix.dirname(destinationPath), sourceDirectoryPath),
    resource: { name, sourceRegistrationId },
    root,
    sourceDirectoryPath,
  };
};

const docsReport = (
  actions: ReadonlyArray<DocsLinkAction>,
  issues: ReadonlyArray<{
    code: string;
    message: string;
    subject: { resource: DocsManagedLink["resource"] };
  }> = [],
) =>
  Schema.decodeUnknownSync(DocsLinkReportSchema)({
    actions,
    complete: issues.length === 0 && actions.every(({ action }) => action !== "conflict"),
    issues,
    kind: "docs-reconciliation-plan",
  });

/** A docs-only sync outcome over one project's docs plan, and its application when given. */
const docsSync = (plan: ReturnType<typeof docsReport>, application?: DocsLinkApplication) =>
  syncOutcome(
    {
      plan: { docs: [plan], docsPending: [] },
      ...(application === undefined
        ? {}
        : { applied: { resources: undefined, docs: [application], docsPending: [] } }),
    },
    undefined,
  );

const docsEnvelope = (
  plan: ReturnType<typeof docsReport>,
  applied?: ReadonlyArray<DocsLinkOutcome>,
) =>
  createPublicEnvelope(
    "sync",
    docsSync(
      plan,
      applied === undefined
        ? undefined
        : Schema.decodeUnknownSync(DocsLinkApplicationSchema)({
            actions: applied,
            complete:
              applied.every((entry) => entry._tag === "applied") && plan.issues.length === 0,
            issues: plan.issues,
            kind: "docs-reconciliation-application",
          }),
    ),
  );

describe("sync", () => {
  const create = docsLink("demo", "/home/me/demo", "guide");
  const remove = docsLink("demo", "/home/me/demo", "old");
  const keep = docsLink("demo", "/home/me/demo", "keep");
  const conflict = docsLink("demo", "/home/me/demo", "mine");
  const plan = docsReport(
    [
      { action: "create", evidence: create },
      { action: "remove", evidence: remove },
      { action: "keep", evidence: keep },
      {
        action: "conflict",
        evidence: conflict,
        code: "docs-destination-occupied",
        message:
          "Existing entries are not adopted or overwritten. Move the conflicting entry, then reconcile again.",
      },
    ],
    [
      {
        code: "docs-resource-unavailable",
        message: "gone/shared/lost is unavailable; its existing links are retained.",
        subject: { resource: create.resource },
      },
    ],
  );

  it.effect("previews each docs action, the issues and the apply command", () =>
    Effect.gen(function* () {
      const envelope = docsEnvelope(plan);
      expect(envelope.status).toBe("partial");
      const output = render(envelope);
      const rows = lines(output);
      expect(rows[0]).toBe("tack sync · project demo · ! partial");
      expect(statementOf(output)).toBe(
        "Preview only: nothing was written. 1 docs link to create, 1 docs link to remove, 1 docs link unchanged, 1 docs conflict.",
      );
      expectRow(
        output,
        `+ create /home/me/demo/docs/guide docs ${sourceRegistrationId}:guide · project demo`,
      );
      expectRow(
        output,
        `− remove /home/me/demo/docs/old docs ${sourceRegistrationId}:old · project demo`,
      );
      expectRow(
        output,
        `· keep /home/me/demo/docs/keep docs ${sourceRegistrationId}:keep · project demo`,
      );
      expect(output).toContain("conflict: Existing entries are not adopted or overwritten.");
      expect(rows).toContain("Issues");
      expect(output).toContain("docs-resource-unavailable");
      expect(output).toContain("docs-resource-unavailable");
      // The preview planned docs only, so the apply command must not widen it to agent links.
      expect(hintsIn(output)).toEqual(["tack sync --project demo --no-adapters --apply"]);
      expect(yield* parseHintsIn(output)).toEqual(["sync"]);
    }),
  );

  it.effect("applies with outcomes, a failed change and a re-preview hint", () =>
    Effect.gen(function* () {
      const applied: ReadonlyArray<DocsLinkOutcome> = [
        { _tag: "applied", action: plan.actions[0]! },
        {
          _tag: "failed",
          action: plan.actions[1]!,
          code: "docs-destination-changed",
          message: "The destination changed after planning; retry reconciliation.",
        },
        { _tag: "applied", action: plan.actions[2]! },
        {
          _tag: "blocked",
          action: plan.actions[3]!,
          code: "docs-destination-occupied",
          message:
            "Existing entries are not adopted or overwritten. Move the conflicting entry, then reconcile again.",
        },
      ];
      const output = render(docsEnvelope(plan, applied));
      expect(statementOf(output)).toBe(
        "Applied: 1 docs link created, 1 docs link unchanged, 1 docs link failed, 1 docs link skipped (conflict).",
      );
      expectRow(
        output,
        `✓ applied create /home/me/demo/docs/guide docs ${sourceRegistrationId}:guide · project demo`,
      );
      expect(output).toContain(
        "failed: The destination changed after planning; retry reconciliation.",
      );
      expect(output).toContain("skipped: Existing entries are not adopted or overwritten.");
      expect(hintsIn(output)).toEqual(["tack sync --project demo --no-adapters"]);
      expect(yield* parseHintsIn(output)).toEqual(["sync"]);
    }),
  );

  it("reports each planned docs conflict under its own reason code in preview and apply", () => {
    const modified = docsLink("demo", "/home/me/demo", "edited");
    const conflicts: ReadonlyArray<DocsLinkAction> = [
      plan.actions[3]!,
      {
        action: "conflict",
        evidence: modified,
        code: "docs-destination-modified",
        message: "The recorded destination was changed; ownership does not authorize removing it.",
      },
    ];
    const conflictPlan = docsReport(conflicts);
    const previewed = docsSync(conflictPlan);
    expect(previewed.diagnostics.map(({ code }) => code)).toEqual([
      "docs-destination-occupied",
      "docs-destination-modified",
    ]);
    const applied = docsSync(
      conflictPlan,
      Schema.decodeUnknownSync(DocsLinkApplicationSchema)({
        actions: conflicts.flatMap((action) =>
          action.action === "conflict"
            ? [{ _tag: "blocked", action, code: action.code, message: action.message }]
            : [],
        ),
        complete: false,
        issues: [],
        kind: "docs-reconciliation-application",
      }),
    );
    expect(applied.diagnostics.map(({ code }) => code)).toEqual([
      "docs-destination-occupied",
      "docs-destination-modified",
    ]);
  });

  it("reports actions the application never attempted", () => {
    const applied: ReadonlyArray<DocsLinkOutcome> = [
      { _tag: "applied", action: plan.actions[0]! },
      { _tag: "skipped", action: plan.actions[1]!, reason: "recovery-pending" },
      { _tag: "skipped", action: plan.actions[2]!, reason: "recovery-pending" },
      { _tag: "skipped", action: plan.actions[3]!, reason: "recovery-pending" },
    ];
    const output = render(docsEnvelope(plan, applied));
    expect(statementOf(output)).toContain("3 docs links not attempted");
    expect(output).toContain("skipped: the application stopped before this action");
  });

  it("states there is nothing to reconcile, with no hint", () => {
    const output = render(docsEnvelope(docsReport([])));
    expect(lines(output)[0]).toBe("tack sync · ✓ success");
    expect(statementOf(output)).toBe(
      "Preview only: nothing was written. There are no docs links to reconcile.",
    );
    expect(hintsIn(output)).toEqual([]);
  });

  it("keeps the view contract", () => {
    expectViewContract(docsEnvelope(plan));
  });

  /** A sync over the captured agent-link plan of project demo and the given docs plans. */
  const combined = (
    docs: ReadonlyArray<ReturnType<typeof docsReport>>,
    applied?: ReadonlyArray<ReadonlyArray<DocsLinkOutcome>>,
  ) => {
    const captured = humanFixture("plan-before");
    return envelopeOf({
      command: "sync",
      plan: { kind: "sync-plan", resources: captured.plan, docs },
      ...(applied === undefined
        ? {}
        : {
            applied: {
              kind: "sync-application",
              resources: humanFixture("reconcile-apply").applied,
              docs: applied.map((actions) => ({
                actions,
                complete: true,
                issues: [],
                kind: "docs-reconciliation-application",
              })),
            },
          }),
    });
  };

  it("shows the docs of a sync with agent links inside the one frame, before its Next", () => {
    const output = render(combined([docsReport([{ action: "create", evidence: create }])]), 120);
    expect(output.match(/^tack sync /gm)).toHaveLength(1);
    const rows = lines(output);
    const docs = rows.indexOf("Docs · project demo");
    expect(docs).toBeGreaterThan(0);
    expect(docs).toBeLessThan(rows.indexOf("Next"));
    expectRow(output, `+ create /home/me/demo/docs/guide docs ${sourceRegistrationId}:guide`);
    expect(hintsIn(output)).toEqual(["tack sync --project demo --apply"]);
  });

  it("heads a docs part whose actions span several projects without a project name", () => {
    const other = docsLink("other", "/home/me/other", "guide");
    const rows = lines(
      render(
        combined([
          docsReport([
            { action: "create", evidence: create },
            { action: "create", evidence: other },
          ]),
        ]),
        120,
      ),
    );
    expect(rows).toContain("Docs");
    expect(rows.some((row) => row.startsWith("Docs ·"))).toBe(false);
  });

  it("states once that a sync with agent links has no docs links to reconcile", () => {
    const output = render(combined([docsReport([]), docsReport([])]));
    expect(output.match(/^tack sync /gm)).toHaveLength(1);
    expect(output.match(/no docs links to reconcile/g)).toHaveLength(1);
    expect(output).not.toContain("Docs ·");
  });

  it("names the project of each docs part a sync applied, and leaves out empty ones", () => {
    const other = docsLink("other", "/home/me/other", "guide");
    const output = render(
      combined(
        [
          docsReport([{ action: "keep", evidence: keep }]),
          docsReport([]),
          docsReport([{ action: "create", evidence: other }]),
        ],
        [
          [{ _tag: "applied", action: { action: "keep", evidence: keep } }],
          [],
          [{ _tag: "applied", action: { action: "create", evidence: other } }],
        ],
      ),
      120,
    );
    expect(output.match(/^tack sync /gm)).toHaveLength(1);
    const rows = lines(output);
    expect(rows[rows.indexOf("Docs · project demo") + 1]).toBe("Applied: 1 docs link unchanged.");
    expect(rows[rows.indexOf("Docs · project other") + 1]).toBe("Applied: 1 docs link created.");
    expect(output).not.toContain("no docs links to reconcile");
  });

  it("frames the docs of several projects once when agent links are left out", () => {
    const other = docsLink("other", "/home/me/other", "guide");
    const output = render(
      createPublicEnvelope(
        "sync",
        syncOutcome(
          {
            plan: {
              docs: [
                docsReport([{ action: "create", evidence: create }]),
                docsReport([{ action: "create", evidence: other }]),
              ],
              docsPending: [],
            },
          },
          undefined,
        ),
      ),
      120,
    );
    const rows = lines(output);
    expect(rows[0]).toBe("tack sync · ✓ success");
    expect(output.match(/^tack sync /gm)).toHaveLength(1);
    expect(rows).toContain("Docs · project demo");
    expect(rows).toContain("Docs · project other");
    expect(hintsIn(output)).toEqual([
      "tack sync --project demo --no-adapters --apply",
      "tack sync --project other --no-adapters --apply",
    ]);
  });
});

// script history clear

const historyEnvelope = (plan: { count: number }, applied?: { removedCount: number }) =>
  createPublicEnvelope("script history clear", {
    classification: "success",
    diagnostics: [],
    plan: { kind: "history-clear-plan", ...plan },
    ...(applied === undefined
      ? {}
      : { applied: { kind: "history-clear-application", ...applied } }),
  });

describe("script history clear", () => {
  it.effect("previews the retained record count and hints --apply", () =>
    Effect.gen(function* () {
      const output = render(historyEnvelope({ count: 3 }));
      expect(lines(output)[0]).toBe("tack script history clear · ✓ success");
      expect(statementOf(output)).toBe(
        "Preview only: nothing was written. 3 run records would be removed.",
      );
      expect(hintsIn(output)).toEqual(["tack script history clear --apply"]);
      expect(yield* parseHintsIn(output)).toEqual(["script history clear"]);
    }),
  );

  it("states what was removed, and when the count differs from the plan", () => {
    expect(lines(render(historyEnvelope({ count: 1 }, { removedCount: 1 })))).toContain(
      "Applied: 1 run record removed.",
    );
    expect(lines(render(historyEnvelope({ count: 3 }, { removedCount: 2 })))).toContain(
      "Applied: 2 run records removed (3 were planned).",
    );
    expect(hintsIn(render(historyEnvelope({ count: 3 }, { removedCount: 3 })))).toEqual([]);
  });

  it("states there is no history", () => {
    expect(lines(render(historyEnvelope({ count: 0 })))).toContain(
      "Preview only: nothing was written. There is no run history to clear.",
    );
    expect(hintsIn(render(historyEnvelope({ count: 0 })))).toEqual([]);
    expect(lines(render(historyEnvelope({ count: 0 }, { removedCount: 0 })))).toContain(
      "Applied. There was no run history to clear.",
    );
  });

  it("renders a failure", () => {
    const failure = createPublicEnvelope("script history clear", {
      classification: "invalid-configuration",
      diagnostics: [
        {
          code: "state-not-initialized",
          message: "Tack is not initialized. Run `tack state init` first.",
          severity: "error",
        },
      ],
      next: [["tack", "state", "init"]],
    });
    const output = render(failure);
    expect(lines(output)[0]).toBe("tack script history clear · ✗ invalid-configuration");
    expect(hintsIn(output)).toEqual(["tack state init"]);
  });
});

// project refresh

const workspaceRecord = (roots: ReadonlyArray<string>) => ({
  gitCommonDirectory: "/home/me/workspace/.git",
  name: "workspace",
  roots,
});

const refreshPlan = (
  overrides: Partial<ProjectRefreshCommandPlan> & {
    readonly project?: ProjectRefreshCommandPlan["refresh"]["projects"][number];
    readonly scope?: ProjectRefreshCommandPlan["refresh"]["scope"];
  } = {},
): ProjectRefreshCommandPlan =>
  Schema.decodeUnknownSync(ProjectRefreshCommandPlanSchema)({
    docs: overrides.docs ?? {
      actions: [],
      complete: true,
      issues: [],
      kind: "docs-reconciliation-plan",
    },
    handMade: overrides.handMade ?? [],
    kind: "project-refresh-command-plan",
    refresh: {
      kind: "project-refresh-plan",
      projects: [
        overrides.project ?? {
          additions: ["/home/me/workspace-feature"],
          expectedManagedLinks: [],
          expectedProject: workspaceRecord(["/home/me/workspace"]),
          observedRoots: ["/home/me/workspace", "/home/me/workspace-feature"],
          reactivations: [],
          removals: [],
        },
      ],
      scope: overrides.scope ?? { _tag: "project", projectName: "workspace" },
      version: 1,
    },
    removals: overrides.removals ?? [],
    selection: overrides.selection ?? {
      selector: overrides.scope ?? { _tag: "project", projectName: "workspace" },
    },
    version: 1,
  });

const refreshResult = (
  overrides: Partial<ProjectRefreshCommandResult> = {},
): ProjectRefreshCommandResult =>
  Schema.decodeUnknownSync(ProjectRefreshCommandResultSchema)({
    docs: overrides.docs ?? {
      actions: [],
      complete: true,
      issues: [],
      kind: "docs-reconciliation-application",
    },
    kind: "project-refresh-command-application",
    refresh: overrides.refresh ?? {
      changes: [
        { action: "added", canonicalRoot: "/home/me/workspace-feature", projectName: "workspace" },
      ],
      removedProjects: [],
      version: 1,
    },
    removals: overrides.removals ?? [],
    version: 1,
  });

const refreshEnvelope = (plan: ProjectRefreshCommandPlan, applied?: ProjectRefreshCommandResult) =>
  createPublicEnvelope(
    "project refresh",
    removalOutcome(
      { plan, ...(applied === undefined ? {} : { applied }) },
      { planned: plan.removals, applied: applied?.removals },
      (applied ?? plan).docs.complete
        ? []
        : [
            {
              code: "project-refresh-docs-partial",
              message: "Docs reconciliation retains conflicts.",
            },
          ],
    ),
  );

describe("project refresh", () => {
  const handoffRoot = "/home/me/workspace-old";
  const handoffLink = evidence("review", {
    _tag: "project-root",
    canonicalPath: handoffRoot,
    projectName: "workspace",
  });
  const handoffPlan = refreshPlan({
    project: {
      additions: ["/home/me/workspace-feature"],
      expectedManagedLinks: [handoffLink],
      expectedProject: workspaceRecord(["/home/me/workspace", handoffRoot]),
      observedRoots: ["/home/me/workspace", "/home/me/workspace-feature"],
      reactivations: [],
      removals: [
        {
          action: "handoff",
          canonicalRoot: handoffRoot,
          finalProject: false,
          hasManagedEvidence: true,
          rootReachable: false,
        },
      ],
    },
    removals: [
      removalPlan(
        {
          _tag: "retry-targets",
          targets: [{ _tag: "project-root", canonicalPath: handoffRoot, projectName: "workspace" }],
        },
        [
          removeOf(handoffLink),
          blockedOf(
            evidence("foreign", {
              _tag: "project-root",
              canonicalPath: handoffRoot,
              projectName: "workspace",
            }),
          ),
        ],
      ),
    ],
    docs: {
      actions: [{ action: "create", evidence: docsLink("workspace", "/home/me/workspace") }],
      complete: true,
      issues: [],
      kind: "docs-reconciliation-plan",
    },
  });

  it.effect("previews root changes, the cleanup and the docs links it mounts", () =>
    Effect.gen(function* () {
      // Wide enough that every row fits on one line, so each reads back whole.
      const output = render(refreshEnvelope(handoffPlan), 120);
      const rows = lines(output);
      expect(rows[0]).toBe("tack project refresh · project workspace · ! partial");
      expect(statementOf(output)).toBe(
        "Preview only: nothing was written. 2 root changes, 1 to remove, 1 blocked, 1 docs link to create.",
      );
      expect(rows).toContain("Project workspace 2 root changes");
      expectRow(output, "+ add /home/me/workspace-feature");
      expectRow(output, "− handoff /home/me/workspace-old has managed links · root unreachable");
      expect(rows).toContain("Cleanup targets");
      expectRow(
        output,
        `− remove /home/me/workspace-old/.claude/skills/review skill ${sourceRegistrationId}:review · claude`,
      );
      expect(rows).toContain("Docs links");
      expectRow(
        output,
        `+ create /home/me/workspace/docs/guide docs ${sourceRegistrationId}:guide · project workspace`,
      );
      expect(hintsIn(output)).toEqual([
        "tack project refresh --project workspace --apply",
        "tack status --project workspace",
      ]);
      expect(yield* parseHintsIn(output)).toEqual(["project refresh", "status"]);
    }),
  );

  it("reproduces an all-projects scope in the apply hint", () => {
    const output = render(refreshEnvelope(refreshPlan({ scope: { _tag: "all" } })));
    expect(hintsIn(output)).toEqual(["tack project refresh --all --apply"]);
  });

  it("preserves a bare --cwd refresh in its apply hint", () => {
    const output = render(
      refreshEnvelope(
        refreshPlan({
          selection: {
            cwd: "/home/me/workspace",
            selector: { _tag: "bare" },
            projectName: "workspace",
            matchedBy: { _tag: "containing-root", root: "/home/me/workspace" },
          },
        }),
      ),
    );
    expect(hintsIn(output)).toContain("tack project refresh --cwd /home/me/workspace --apply");
  });

  it.effect("applies with root changes, cleanup outcomes, retained obligations and hints", () =>
    Effect.gen(function* () {
      const [removalPlanned] = handoffPlan.removals;
      if (removalPlanned === undefined) throw new Error("The fixture plans one cleanup.");
      const applied = refreshResult({
        docs: {
          actions: [
            {
              _tag: "failed",
              action: { action: "create", evidence: docsLink("workspace", "/home/me/workspace") },
              code: "docs-destination-changed",
              message: "The destination changed before mutation; retry reconciliation.",
            },
          ],
          complete: false,
          issues: [],
          kind: "docs-reconciliation-application",
        },
        refresh: {
          changes: [
            {
              action: "added",
              canonicalRoot: "/home/me/workspace-feature",
              projectName: "workspace",
            },
            { action: "handoff", canonicalRoot: handoffRoot, projectName: "workspace" },
          ],
          removedProjects: [],
          version: 1,
        },
        removals: [
          removalResult(
            removalPlanned.actions.map((action) =>
              action._tag === "remove"
                ? {
                    _tag: "failed" as const,
                    action,
                    code: "filesystem-failure" as const,
                    message: "EACCES: permission denied",
                  }
                : appliedOutcomeOf(action),
            ),
            {
              pending: [
                pendingOf(handoffLink, "root-removal", {
                  _tag: "filesystem-failure",
                  message: "EACCES: permission denied",
                }),
              ],
            },
          ),
        ],
      });
      const envelope = refreshEnvelope(handoffPlan, applied);
      expect(envelope.status).toBe("partial");
      const output = render(envelope);
      const rows = lines(output);
      expect(rows[0]).toBe("tack project refresh · project workspace · ! partial");
      expect(rows).toContain("Project workspace 2 root changes");
      expectRow(output, "✓ applied add /home/me/workspace-feature");
      expectRow(output, "✓ applied handoff /home/me/workspace-old");
      expect(output).toContain("failed (filesystem-failure): EACCES: permission denied");
      expect(output).toContain("skipped: The destination is an existing directory.");
      expect(output).toContain(
        "failed: The destination changed before mutation; retry reconciliation.",
      );
      expect(rows).toContain("Pending cleanup");
      expect(output).toContain("project-refresh-docs-partial");
      // The added root has no links yet, so syncing its project comes last.
      expect(hintsIn(output)).toEqual([
        "tack state clean --pending --project workspace",
        "tack sync --no-adapters --project workspace",
        "tack sync --project workspace",
        "tack sync --project workspace --apply",
      ]);
      expect(yield* parseHintsIn(output)).toEqual(["state clean", "sync", "sync", "sync"]);
    }),
  );

  it("notes a cleanup that recorded no result and names removed projects", () => {
    const applied = refreshResult({
      refresh: {
        changes: [{ action: "deregistered", canonicalRoot: handoffRoot, projectName: "workspace" }],
        removedProjects: ["workspace"],
        version: 1,
      },
    });
    const output = render(refreshEnvelope(handoffPlan, applied));
    expect(output).toContain("No result was recorded for this cleanup; it was not applied.");
    expect(statementOf(output)).toContain("1 project removed (workspace)");
    expectRow(output, "✓ applied deregister /home/me/workspace-old");
  });

  it("states everything is up to date", () => {
    const plan = refreshPlan({
      project: {
        additions: [],
        expectedManagedLinks: [],
        expectedProject: workspaceRecord(["/home/me/workspace"]),
        observedRoots: ["/home/me/workspace"],
        reactivations: [],
        removals: [],
      },
    });
    const output = render(refreshEnvelope(plan));
    expect(statementOf(output)).toBe(
      "Preview only: nothing was written. Everything is up to date.",
    );
    expect(lines(output)).toContain("Project workspace no root changes");
    expect(hintsIn(output)).toEqual([]);
  });

  const handMadePlan = refreshPlan({
    handMade: [
      {
        adapter: "claude",
        kind: "skill",
        path: "/home/me/workspace-feature/.claude/skills/code-review",
        entry: "directory",
      },
    ],
  });

  it("keeps the view contract", () => {
    expectViewContract(refreshEnvelope(handoffPlan));
    expectViewContract(refreshEnvelope(handMadePlan));
  });

  it("lists the hand-made entries of an added root in the preview and after apply", () => {
    for (const output of [
      render(refreshEnvelope(handMadePlan)),
      render(refreshEnvelope(handMadePlan, refreshResult())),
    ]) {
      const rows = lines(output);
      const heading = rows.indexOf("Hand-made, left untouched");
      expect(heading).toBeGreaterThan(rows.indexOf("Project workspace 1 root change"));
      expect(rows[heading + 1]).toBe(
        "  /home/me/workspace-feature/.claude/skills/code-review  folder · claude skill",
      );
      expect(heading).toBeLessThan(rows.indexOf("Next"));
    }
    expect(render(refreshEnvelope(refreshPlan()))).not.toContain("Hand-made");
  });

  it("renders a failure", () => {
    const failure = createPublicEnvelope(
      "project refresh",
      outcomeForError(new RemovalProjectNotFoundError({ projectName: "nope" })),
    );
    expect(hintsIn(render(failure))).toEqual(["tack project"]);
  });
});

// Undecodable payloads

describe("undecodable payloads", () => {
  it("returns undefined so the generic view is used", () => {
    for (const command of Object.keys(removalViews)) {
      for (const payload of [{ unexpected: true }, { kind: "other" }, [], null]) {
        const envelope = createPublicEnvelope(command, previewOutcome({ plan: payload }));
        expect(removalViews[command]?.(envelope, styleOf()), command).toBeUndefined();
        expect(render(envelope)).toContain(`tack ${command}`);
      }
    }
    // A readable plan with an unreadable application is declined too.
    const cleaned = cleanupEnvelope("clean", mixedPlan, undefined, projectSelection);
    expect(
      removalViews["state clean"]?.({ ...cleaned, applied: { kind: "other" } }, styleOf()),
    ).toBeUndefined();
  });
});

// Other-operation sanity: unrelated commands are not claimed by this family.

describe("registry", () => {
  it("covers exactly the preview/apply removal operations", () => {
    expect(Object.keys(removalViews).sort()).toEqual([
      "adapter disable",
      "project refresh",
      "project remove",
      "script history clear",
      "source remove",
      "state clean",
      "state reset",
    ]);
  });
});

// Views read directly, with the hints they record

const otherRoot = {
  _tag: "project-root",
  canonicalPath: "/home/me/other",
  projectName: "other",
} as const;

const linkEvidence = (
  name: string,
  adapter: ManagedLinkEvidence["adapter"] = "claude",
  target: ManagedLinkEvidence["target"] = demoRoot,
) =>
  ({
    adapter,
    address: { kind: "skill", name, sourceRegistrationId: sourceRegistrationId },
    sourceDirectoryPath: `/home/me/skills/${name}`,
    sourceRegistrationId: sourceRegistrationId,
    target,
  }) satisfies ManagedLinkEvidence;

const blockedBy = (link: ManagedLinkEvidence) => {
  const destinationPath = managedLinkDestinationPath(link);
  return {
    _tag: "blocked",
    destinationPath,
    evidence: link,
    message: "A directory is in the way.",
    observation: { _tag: "entry", destinationPath, entryType: "directory" },
  };
};

const mountedDocsLink = (projectName: string, root: string) => {
  const destinationPath = `${root}/.tack/docs/handbook`;
  const sourceDirectoryPath = "/home/me/source/docs/handbook";
  return {
    projectName,
    root,
    resource: { sourceRegistrationId: sourceRegistrationId, name: "handbook" },
    destinationPath,
    sourceDirectoryPath,
    relativeTarget: posix.relative(posix.dirname(destinationPath), sourceDirectoryPath),
  };
};

const rawRemovalPlan = (scope: unknown, overrides: Record<string, unknown> = {}) => ({
  actions: [],
  cause: "clean",
  expectedManagedLinks: [],
  expectedPendingRemovals: [],
  finalizeProject: false,
  kind: "managed-removal-plan",
  scope,
  version: 1,
  ...overrides,
});

const recorded = (command: string, plan: unknown, applied?: unknown) => {
  const view = removalViews[command];
  if (view === undefined) throw new Error(`No removal view for ${command}.`);
  const { hints, style } = hintRecorder();
  const text = view(envelopeOf({ command, plan, applied }), style);
  return { hints, text: text ?? "", flatText: flat(text) };
};

describe("state clean view", () => {
  it("warns that removing a link through a directory alias removes it for the other adapters too", () => {
    const link = linkEvidence("review");
    const { flatText, hints } = recorded("state clean", {
      ...rawRemovalPlan(
        { _tag: "maintenance" },
        {
          actions: [
            {
              _tag: "remove",
              alsoReachedBy: ["codex"],
              destinationPath: managedLinkDestinationPath(link),
              evidence: link,
            },
          ],
          expectedManagedLinks: [link],
          finalizeProject: true,
          expectedProjects: [
            {
              gitCommonDirectory: "/home/me/demo/.git",
              name: "demo",
              roots: [],
              removingRoots: ["/home/me/demo"],
            },
          ],
        },
      ),
      selection: { selector: { _tag: "user" }, targets: [] },
    });
    expect(flatText).toContain(
      "also reached by codex through a directory alias; they lose this link too",
    );
    expect(flatText).toContain(
      "Registration of 1 project demo is removed once all its cleanup settles.",
    );
    expect(flatText).toContain("Scope retained cleanup of projects and roots being removed");
    expect(hints).toEqual(["tack state clean --pending --user --apply"]);
  });

  it("names the project a project-wide preview finalizes, and repeats --all", () => {
    const link = linkEvidence("review");
    const { flatText, hints } = recorded("state clean", {
      ...rawRemovalPlan(
        { _tag: "project", projectName: "demo" },
        {
          actions: [
            { _tag: "retire", destinationPath: managedLinkDestinationPath(link), evidence: link },
          ],
          expectedManagedLinks: [link],
          finalizeProject: true,
        },
      ),
      selection: { selector: { _tag: "all" }, targets: [] },
    });
    expect(flatText).toContain("tack state clean · all projects and user · ✓ success");
    expect(flatText).toContain(
      "Registration of 1 project demo is removed once all its cleanup settles.",
    );
    expect(hints).toEqual(["tack state clean --all --apply"]);
  });

  it("finalizes no named project for selected targets, and a bare selection without a root adds no flags", () => {
    const link = linkEvidence("review");
    const { flatText, hints } = recorded("state clean", {
      ...rawRemovalPlan(
        { _tag: "selected-targets", targets: [demoRoot, otherRoot] },
        {
          actions: [
            { _tag: "retire", destinationPath: managedLinkDestinationPath(link), evidence: link },
          ],
          expectedManagedLinks: [link],
          finalizeProject: true,
        },
      ),
      selection: { selector: { _tag: "bare" }, targets: [] },
    });
    expect(flatText).toContain("tack state clean · project unknown · ✓ success");
    expect(flatText).not.toContain("Registration of");
    expect(hints).toEqual(["tack state clean --apply"]);
  });

  it("reports a finalized project and the docs mounts still owed, with their last attempt", () => {
    const docs = mountedDocsLink("demo", "/home/me/demo");
    const { flatText } = recorded(
      "state clean",
      rawRemovalPlan(
        { _tag: "project", projectName: "demo" },
        { docsActions: [{ action: "remove", evidence: docs }], finalizeProject: true },
      ),
      {
        actions: [],
        docsActions: [
          {
            _tag: "failed",
            action: { action: "remove", evidence: docs },
            code: "io",
            message: "busy",
          },
        ],
        docsPending: [
          {
            cause: "clean",
            evidence: docs,
            lastResult: { _tag: "blocked", message: "Something is in the way." },
          },
          { cause: "clean", evidence: mountedDocsLink("demo", "/home/me/demo2") },
        ],
        finalizedProject: true,
        kind: "managed-removal-application",
        pending: [],
        version: 1,
      },
    );
    expect(flatText).toContain("1 project registration removed");
    expect(flatText).toContain(
      `last attempt blocked: Something is in the way. ! pending ~/demo2/.tack/docs/handbook docs ${sourceRegistrationId}:handbook · project demo · clean`,
    );
    expect(flatText).toContain(
      `Pending cleanup ! pending ~/demo/.tack/docs/handbook docs ${sourceRegistrationId}:handbook · project demo · clean last attempt blocked: Something is in the way.`,
    );
  });
});

describe("state clean view with nothing to remove", () => {
  it("lists no targets, names the containing root and points at the blocked targets in order", () => {
    const { flatText, hints } = recorded("state clean", {
      ...rawRemovalPlan(
        { _tag: "selected-targets", targets: [] },
        {
          actions: [
            blockedBy(linkEvidence("review", "claude", userTarget)),
            blockedBy(linkEvidence("review")),
            blockedBy(linkEvidence("review", "claude", otherRoot)),
          ],
          expectedManagedLinks: [
            linkEvidence("review", "claude", userTarget),
            linkEvidence("review"),
            linkEvidence("review", "claude", otherRoot),
          ],
        },
      ),
      selection: {
        selector: { _tag: "bare" },
        containingRoot: { projectName: "demo", root: "/home/me/demo" },
        targets: [],
      },
    });
    expect(flatText).toContain("tack state clean · project demo · ✓ success");
    expect(flatText).toContain(
      "Targets none selected from the containing root ~/demo claude → user · 1 blocked claude → demo · 1 blocked claude → other · 1 blocked Actions",
    );
    expect(hints).toEqual([
      "tack status --project demo",
      "tack status --project other",
      "tack status --user",
    ]);
  });
});

describe("removal scope text", () => {
  it("names one selected target, counts several, and names an adapter", () => {
    expect(removalScopeText({ _tag: "selected-targets", targets: [demoRoot] })).toBe(
      "project demo",
    );
    expect(
      removalScopeText({
        _tag: "retry-targets",
        targets: [{ _tag: "user", canonicalPath: "/home/me" }],
      }),
    ).toBe("user");
    expect(removalScopeText({ _tag: "selected-targets", targets: [demoRoot, otherRoot] })).toBe(
      "2 targets",
    );
    expect(removalScopeText({ _tag: "adapter", adapter: "codex" })).toBe("adapter codex");
  });
});

describe("removal scope block", () => {
  it("states one root of a project, or every target for an adapter or a source", () => {
    expect(
      removalScopeBlock(
        { _tag: "project-root", canonicalRoot: "/home/me/demo", projectName: "demo" },
        undefined,
        plainStyle,
      ),
    ).toEqual(["Scope  root ~/demo of project demo"]);
    expect(removalScopeBlock({ _tag: "adapter", adapter: "codex" }, undefined, plainStyle)).toEqual(
      ["Scope  every project and the user target"],
    );
    expect(
      removalScopeBlock({ _tag: "source", sourceRegistrationId }, undefined, plainStyle),
    ).toEqual(["Scope  every project and the user target"]);
  });
});

describe("docs summary", () => {
  it("phrases the counts as done once applied", () => {
    const docs = mountedDocsLink("demo", "/home/me/demo");
    expect(
      docsSummary(
        {
          actions: [
            { action: "create", evidence: docs },
            { action: "remove", evidence: docs },
            { action: "keep", evidence: docs },
          ],
        },
        true,
      ),
    ).toEqual(["1 docs link created", "1 docs link removed", "1 docs link unchanged"]);
  });
});

describe("docs-only sync view", () => {
  /** A `sync --no-adapters` envelope over one docs plan, and its application when given. */
  const docsOnly = (input: { readonly plan: unknown; readonly applied?: unknown }) =>
    envelopeOf({
      command: "sync",
      plan: { kind: "sync-plan", resources: null, docs: [input.plan] },
      ...(input.applied === undefined
        ? {}
        : { applied: { kind: "sync-application", resources: null, docs: [input.applied] } }),
    });
  const docsPlan = (actions: ReadonlyArray<unknown>) => ({
    actions,
    complete: true,
    issues: [],
    kind: "docs-reconciliation-plan",
  });

  it("offers nothing to apply when every docs link is already in place", () => {
    const { hints, style } = hintRecorder();
    const text = renderSync(
      docsOnly({
        plan: docsPlan([{ action: "keep", evidence: mountedDocsLink("demo", "/home/me/demo") }]),
      }),
      style,
    );
    expect(flat(text)).toContain("tack sync · project demo · ✓ success");
    expect(hints).toEqual([]);
  });

  it("offers nothing more once every docs link applied", () => {
    const { hints, style } = hintRecorder();
    const docs = mountedDocsLink("demo", "/home/me/demo");
    const text = renderSync(
      docsOnly({
        plan: docsPlan([{ action: "create", evidence: docs }]),
        applied: {
          actions: [{ _tag: "applied", action: { action: "create", evidence: docs } }],
          complete: true,
          issues: [],
          kind: "docs-reconciliation-application",
        },
      }),
      style,
    );
    expect(flat(text)).toContain("Applied: 1 docs link created.");
    expect(hints).toEqual([]);
  });

  it("names no project when the actions span several", () => {
    const text = renderSync(
      docsOnly({
        plan: docsPlan([
          { action: "create", evidence: mountedDocsLink("demo", "/home/me/demo") },
          { action: "create", evidence: mountedDocsLink("other", "/home/me/other") },
        ]),
      }),
      plainStyle,
    );
    expect(text?.split("\n")[0]).toBe("tack sync · ✓ success");
  });
});

describe("project refresh view", () => {
  const record = {
    gitCommonDirectory: "/home/me/demo/.git",
    name: "demo",
    roots: ["/home/me/demo"],
  };
  const reactivationPlan = (selection: unknown) => ({
    docs: { actions: [], complete: true, issues: [], kind: "docs-reconciliation-plan" },
    handMade: [],
    kind: "project-refresh-command-plan",
    refresh: {
      kind: "project-refresh-plan",
      projects: [
        {
          additions: [],
          expectedManagedLinks: [],
          expectedProject: { ...record, roots: ["/home/me/demo", "/home/me/demo-old"] },
          observedRoots: ["/home/me/demo", "/home/me/demo-wt"],
          reactivations: ["/home/me/demo-wt"],
          removals: [
            {
              action: "deregister",
              canonicalRoot: "/home/me/demo-old",
              finalProject: true,
              hasManagedEvidence: false,
              rootReachable: true,
            },
          ],
        },
      ],
      scope: { _tag: "all" },
      version: 1,
    },
    removals: [],
    selection,
    version: 1,
  });

  it("previews a reactivated root and the final root of a project, without scope flags for a bare run", () => {
    const { text, hints } = recorded(
      "project refresh",
      reactivationPlan({ selector: { _tag: "bare" } }),
    );
    expect(text).toContain("tack project refresh · all projects · ✓ success\n");
    expect(text).toContain("Project demo 2 root changes\n");
    expect(text).toMatch(/\+ reactivate +~\/demo-wt\n/);
    expect(text).toMatch(/− deregister +~\/demo-old +final root of the project\n/);
    expect(hints).toEqual(["tack project refresh --apply"]);
  });

  it("reports an applied reactivation", () => {
    const { text } = recorded("project refresh", reactivationPlan({ selector: { _tag: "bare" } }), {
      docs: { actions: [], complete: true, issues: [], kind: "docs-reconciliation-application" },
      kind: "project-refresh-command-application",
      refresh: {
        changes: [
          { action: "reactivated", canonicalRoot: "/home/me/demo-wt", projectName: "demo" },
        ],
        removedProjects: [],
        version: 1,
      },
      removals: [],
      version: 1,
    });
    expect(text).toMatch(/✓ applied +reactivate +~\/demo-wt\n/);
  });
});
