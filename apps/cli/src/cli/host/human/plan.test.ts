import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ReconciliationApplyResultSchema } from "../../../domain/reconciliation/reconciliation-application-schema.ts";
import { ReconciliationCommandPlanSchema } from "../../../domain/reconciliation/reconciliation-schema.ts";
import { envelopeOf, flat, hintRecorder, humanFixture, testHome } from "./human.test-support.ts";
import { renderPlan } from "./plan.ts";
import { makeStyle } from "./style.ts";

const root = "/fx/リポジトリ";
const planOf = (name: string) => {
  const fixture = humanFixture(name);
  return { fixture, plan: Schema.decodeUnknownSync(ReconciliationCommandPlanSchema)(fixture.plan) };
};

const render = (input: { plan: unknown; applied?: unknown }) => {
  // Wide enough that no row wraps.
  const { hints, style } = hintRecorder(
    makeStyle({ color: false, homeDirectory: testHome, width: 160 }),
  );
  const text = renderPlan(envelopeOf({ command: "sync", ...input }), style) ?? "";
  return { hints, text, flatText: flat(text) };
};

describe("sync plan view", () => {
  it("shows failed and skipped outcomes beside the directory aliases a unit writes through", () => {
    const { fixture, plan } = planOf("reconcile-apply");
    const applied = Schema.decodeUnknownSync(ReconciliationApplyResultSchema)(fixture.applied);
    const [unit, ...otherUnits] = plan.units;
    const [outcome, ...otherOutcomes] = applied.units;
    if (unit === undefined || outcome === undefined) throw new Error("The fixture has no unit.");
    const [first, second, third, ...rest] = outcome.actions;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error("The fixture unit has too few outcomes.");
    const { flatText } = render({
      plan: {
        ...plan,
        units: [
          {
            ...unit,
            directoryAliases: [
              {
                alsoReachedBy: ["codex"],
                directory: `${root}/.claude/skills`,
                kind: "skill",
                physicalDirectory: `${root}/.agents/skills`,
              },
              {
                alsoReachedBy: ["codex"],
                directory: `${root}/.claude/commands`,
                kind: "command",
                physicalDirectory: `${root}/.claude/commands`,
              },
            ],
          },
          ...otherUnits,
        ],
      },
      applied: {
        ...applied,
        units: [
          {
            ...outcome,
            status: "partial",
            actions: [
              first,
              {
                _tag: "failed",
                action: second.action,
                code: "filesystem-failure",
                message: "disk full",
                path: `${root}/.claude/skills/localized`,
              },
              { _tag: "skipped", action: third.action, reason: "an earlier action failed" },
              ...rest,
            ],
          },
          ...otherOutcomes,
        ],
      },
    });
    expect(flatText).toContain("unit partial");
    expect(flatText).toContain(
      "failed create .claude/skills/localized skill 0d5b3402-2162-4620-ae41-ddc81538eb23:localized · filesystem-failure: disk full",
    );
    expect(flatText).toContain(
      "skipped create .claude/skills/planner skill 0d5b3402-2162-4620-ae41-ddc81538eb23:planner · an earlier action failed",
    );
    expect(flatText).toContain(
      `· alias ${root}/.claude/skills → ${root}/.agents/skills, shared with codex`,
    );
    expect(flatText).toContain(`· ${root}/.claude/commands is shared with codex`);
  });

  it("previews a replaced link and a blocked agent directory", () => {
    const { plan } = planOf("plan-before");
    const [unit, ...otherUnits] = plan.units;
    if (unit === undefined) throw new Error("The fixture has no unit.");
    const { text, flatText, hints } = render({
      plan: {
        ...plan,
        units: [
          {
            ...unit,
            actions: unit.actions.map((action) =>
              action._tag === "link-create"
                ? { ...action, previousEvidence: action.evidence }
                : action,
            ),
            conflicts: [
              {
                _tag: "destination-directory-conflict",
                observation: {
                  _tag: "entry",
                  destinationPath: `${root}/.claude/skills`,
                  entryType: "file",
                },
              },
            ],
          },
          ...otherUnits,
        ],
      },
    });
    expect(text.split("\n")[0]).toBe("tack sync · project demo · ✓ success");
    expect(flatText).toContain("replace .claude/skills/localized");
    expect(flatText).toContain(
      "conflict .claude/skills destination-directory-conflict: an entry Tack cannot use occupies the agent directory",
    );
    expect(hints).toContain("tack sync --project demo --apply");
  });

  it("says which agents a selected command or context reaches, and why", () => {
    const { plan } = planOf("reconcile-preview");
    const [unit] = plan.units;
    const [resolution] = plan.namespaceResolutions;
    if (unit === undefined || resolution === undefined) throw new Error("The fixture is empty.");
    // The fixture selects a command for claude and codex, which take none.
    expect(render({ plan }).flatText).toContain(
      "Commands reach no agent here: Tack does not link commands for claude, codex.",
    );
    const cursor = {
      ...unit,
      adapter: "cursor",
      delivery: { command: "delivered", skill: "delivered" },
    };
    expect(render({ plan: { ...plan, units: [...plan.units, cursor] } }).flatText).toContain(
      "Commands reach cursor only: Tack does not link commands for claude, codex.",
    );
    const context = {
      kind: "context",
      name: "conventions",
      owner: "shared",
      sourceRegistrationId: "0d5b3402-2162-4620-ae41-ddc81538eb23",
    } as const;
    const onlyContext = {
      ...plan,
      namespaceResolutions: [
        {
          ...resolution,
          resolution: {
            ...resolution.resolution,
            groups: [{ _tag: "selected", members: [context] }],
          },
        },
      ],
    };
    const { flatText } = render({ plan: onlyContext });
    expect(flatText).toContain("Context reaches no agent: Tack does not link context yet.");
    expect(flatText).not.toContain("Commands reach");
  });

  it("names what a project unit leaves to the user's link", () => {
    const { plan } = planOf("plan-before");
    const [unit] = plan.units;
    if (unit === undefined) throw new Error("The fixture has no unit.");
    const review = {
      kind: "skill",
      name: "review",
      sourceRegistrationId: "0d5b3402-2162-4620-ae41-ddc81538eb23",
    } as const;
    const settled = {
      ...unit,
      actions: [],
      linkedForUser: [review],
      summary: { ...unit.summary, create: 0, remove: 0, retire: 0, release: 0 },
    };
    expect(render({ plan: { ...plan, units: [settled] } }).flatText).toContain(
      `claude → demo · 1 linked for the user skip skill ${review.sourceRegistrationId}:review linked for the user`,
    );
  });

  it("repeats --user in the apply hint of a user preview", () => {
    const { plan } = planOf("plan-before");
    const { text, hints } = render({
      plan: { ...plan, selection: { selector: { _tag: "user" }, targets: [] } },
    });
    expect(text.split("\n")[0]).toBe("tack sync · user · ✓ success");
    expect(hints).toContain("tack sync --user --apply");
  });

  it("names the root of each unit when a project has several roots", () => {
    const { plan } = planOf("plan-before");
    const [unit] = plan.units;
    if (unit === undefined) throw new Error("The fixture has no unit.");
    const worktree = {
      _tag: "project-root",
      canonicalPath: "/fx/worktree",
      projectName: "demo",
    } as const;
    const { flatText } = render({
      plan: {
        ...plan,
        selection: { ...plan.selection, targets: [...plan.selection.targets, worktree] },
        units: [unit, { ...unit, target: worktree, actions: [] }],
      },
    });
    expect(flatText).toContain(`claude → demo · ${root} ·`);
    expect(flatText).toContain("claude → demo · /fx/worktree ·");
  });

  it("names only the project when it has one root", () => {
    const { flatText } = render({ plan: planOf("plan-before").plan });
    expect(flatText).toContain("claude → demo ·");
    expect(flatText).not.toContain(`claude → demo · ${root}`);
  });

  it.each([
    [1, "1 item needs attention."],
    [2, "2 items need attention."],
  ])("agrees the verb with %i item(s) needing attention", (conflicts, statement) => {
    const { plan } = planOf("plan-before");
    const [unit, ...otherUnits] = plan.units;
    if (unit === undefined) throw new Error("The fixture has no unit.");
    const { flatText } = render({
      plan: {
        ...plan,
        units: [{ ...unit, summary: { ...unit.summary, conflict: conflicts } }, ...otherUnits],
      },
    });
    expect(flatText).toContain(statement);
  });
});
