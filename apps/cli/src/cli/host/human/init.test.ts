import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  InitApplicationSchema,
  InitPlanSchema,
} from "../../../domain/setup/machine-init-schema.ts";
import {
  envelopeOf,
  expectViewContract,
  flat,
  hintRecorder,
  humanFixture,
} from "./human.test-support.ts";
import { renderInit } from "./init.ts";
import { makeStyle } from "./style.ts";

const style = makeStyle({ color: false, homeDirectory: "/fx/home", width: 160 });

const render = (input: Parameters<typeof envelopeOf>[0]) => {
  const { hints, style: recording } = hintRecorder(style);
  const text = renderInit(envelopeOf(input), recording);
  return { hints, text: text ?? "", flatText: flat(text) };
};

const trouble = humanFixture("init-apply-trouble");
const applied = Schema.decodeUnknownSync(InitApplicationSchema)(trouble.applied);

describe("init view", () => {
  it("reports what setting up a new machine wrote and the hand-made entries, then names the guide", () => {
    const fresh = humanFixture("init-apply");
    const plan = Schema.decodeUnknownSync(InitPlanSchema)(fresh.plan);
    const links = (plan.user.resources?.units ?? []).reduce(
      (total, unit) => total + unit.summary.create,
      0,
    );
    const { flatText, hints } = render(fresh);
    expect(flatText).toContain(
      `Created ~/.tack. Enabled claude, codex. Linked ${links} skills at user scope.`,
    );
    expect(flatText).toContain(
      "found claude ~/.claude, codex ~/.codex, cursor not found (~/.cursor)",
    );
    expect(flatText).toContain("applied create .claude/skills/use-tack");
    expect(flatText).toContain(
      "Hand-made, left untouched ~/.claude/skills/my-own folder · claude skill",
    );
    // A first run's first step is the guide, the same for a person and an agent.
    expect(hints).toEqual(["tack guide onboarding", "tack source add PATH"]);
  });

  it("names the commands and failures an apply reports", () => {
    const [unit] = applied.user.resources?.units ?? [];
    const [first, ...rest] = unit?.actions ?? [];
    if (unit === undefined || first === undefined) throw new Error("The fixture applied nothing.");
    const action = first.action;
    if (action._tag !== "link-create") throw new Error("The fixture's first action is no link.");
    // Cursor links commands too: a command link lands in its command folder.
    const command = {
      _tag: "applied",
      action: {
        ...action,
        destinationPath: "/fx/home/.cursor/commands/ship.md",
        evidence: {
          ...action.evidence,
          address: { ...action.evidence.address, kind: "command", name: "ship" },
        },
      },
    };
    const failed = {
      _tag: "failed",
      action,
      code: "filesystem-failure",
      message: "permission denied",
      path: "/fx/home/.cursor/skills/author-tack-profiles",
    };
    // A link to a skill no longer picked for the user is removed.
    const removed = {
      _tag: "applied",
      action: {
        _tag: "link-remove",
        destinationPath: "/fx/home/.cursor/skills/old",
        evidence: action.evidence,
        reason: "deselected",
      },
    };
    const { flatText } = render({
      ...trouble,
      applied: {
        ...applied,
        user: {
          ...applied.user,
          resources: {
            ...applied.user.resources,
            units: [{ ...unit, actions: [command, failed, removed, ...rest] }],
          },
        },
      },
    });
    expect(flatText).toContain(
      "Linked 2 skills and 1 command at user scope. Removed 1 link. 1 link failed.",
    );
  });

  it("says nothing was written on a machine that is already set up", () => {
    const fresh = humanFixture("init-apply");
    const plan = Schema.decodeUnknownSync(InitPlanSchema)(fresh.plan);
    const settled = {
      ...plan,
      state: "exists",
      adapters: { ...plan.adapters, enabled: plan.adapters.toEnable, toEnable: [] },
      user: { ...plan.user, resources: null },
    };
    const again = {
      ...fresh,
      plan: settled,
      applied: {
        ...applied,
        state: "existed",
        adaptersEnabled: [],
        user: { ...applied.user, resources: null },
      },
      next: ["tack doctor"],
    };
    const { flatText, hints } = render(again);
    expect(flatText).toContain("Nothing was written: Tack was already set up on this machine.");
    expect(flatText).not.toContain("→ user");
    expect(hints).toEqual(["tack doctor"]);
    // A conflict left from an earlier run is still counted.
    const conflicted = Schema.decodeUnknownSync(InitPlanSchema)(trouble.plan);
    expect(
      render({
        ...trouble,
        plan: {
          ...conflicted,
          state: "exists",
          adapters: { ...conflicted.adapters, enabled: ["cursor"], toEnable: [] },
        },
        applied: {
          ...applied,
          state: "existed",
          adaptersEnabled: [],
          user: { ...applied.user, resources: { ...applied.user.resources, units: [] } },
        },
      }).flatText,
    ).toContain(
      "Nothing was written: Tack was already set up on this machine. 1 item needs attention.",
    );
  });

  it("leaves an envelope it cannot read to the generic view", () => {
    expect(
      renderInit(envelopeOf({ command: "init", plan: { kind: "something-else" } }), style),
    ).toBeUndefined();
  });

  it("keeps the view contract for every captured init envelope", () => {
    for (const name of ["init-apply", "init-apply-trouble", "init-no-agent"])
      expectViewContract(humanFixture(name), { homeDirectory: "/fx/home" });
  });
});
