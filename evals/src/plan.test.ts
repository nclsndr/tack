import { describe, expect, it } from "vitest";
import { evalPrompts } from "@tackup/harness/prompts/evals";
import { digest, planCampaign, plannedTrial, renderPrompt, scoreGrade } from "./plan.ts";
import type { EvalTask, TaskSuite } from "./contract.ts";

const task: EvalTask = {
  taskId: "task-a",
  version: 1,
  title: "Discover",
  difficulty: "easy",
  tags: ["smoke", "discovery"],
  family: "quick",
  criteria: [
    { id: "answer", weight: 0.75, requiredForPass: true },
    { id: "evidence", weight: 0.25, requiredForPass: false },
  ],
  prepare: async () => ({ cwd: "/world", request: "find", publicFacts: {} }),
  grade: async () => ({ criteria: [], violatedInvariants: [] }),
  oracle: async () => ({ commands: [], finalAnswer: "found" }),
};
const conversation: EvalTask = {
  ...task,
  taskId: "task-b",
  tags: ["onboarding"],
  family: "long",
  prompt: "getting-started",
  followUps: ["My skills are in ~/kit.", "Yes."],
};
const suite: TaskSuite = {
  contractVersion: 1,
  families: [
    { id: "quick", limits: { wallSeconds: 120, toolCalls: 12, outputBytes: 4194304 } },
    {
      id: "long",
      limits: { wallSeconds: 600, toolCalls: 60, outputBytes: 4194304, maxTurns: 40, budgetUsd: 1 },
    },
  ],
  tasks: [task, conversation],
};
const claude = { driver: "claude", model: "sonnet", effort: "low" } as const;
const codex = { driver: "codex", model: "gpt-6-luna", effort: "low" } as const;
const campaign = { seed: 1, profiles: [claude] };

describe("campaign planning", () => {
  it("runs every task once on each profile from its harness prompt and family limits by default", () => {
    const plan = planCampaign(campaign, suite);

    expect(plan.trials).toEqual([
      {
        id: `all-task-a-claude-${digest(JSON.stringify(claude)).slice(0, 8)}-1-baseline`,
        stage: "all",
        taskId: "task-a",
        profile: claude,
        arm: "baseline",
        seed: 1,
        prompt: {
          source: "harness:task",
          text: evalPrompts.task,
          sha256: digest(evalPrompts.task),
        },
        skills: [],
        followUps: 0,
        limits: { wallSeconds: 120, toolCalls: 12, outputBytes: 4194304 },
      },
      expect.objectContaining({
        taskId: "task-b",
        prompt: expect.objectContaining({ source: "harness:getting-started" }),
        followUps: 2,
        limits: expect.objectContaining({ maxTurns: 40, budgetUsd: 1 }),
      }),
    ]);
    expect(plan.confirmation).toMatch(/^[a-f0-9]{16}$/);
    expect(planCampaign({ ...campaign, seed: 3 }, suite).confirmation).not.toBe(plan.confirmation);
  });

  it("pairs seeds and alternates arm order across repetitions", () => {
    const plan = planCampaign(
      {
        ...campaign,
        arms: [{ id: "baseline" }, { id: "candidate", prompt: { text: "Do: {{request}}" } }],
        stages: [{ id: "smoke", taskIds: ["task-a"], repetitions: 2 }],
      },
      suite,
    );

    expect(plan.trials.map((trial) => [trial.seed, trial.arm])).toEqual([
      [1, "baseline"],
      [1, "candidate"],
      [2, "candidate"],
      [2, "baseline"],
    ]);
  });

  it("selects each stage's tasks by id or tag, with its own arms, profiles and repetitions", () => {
    const plan = planCampaign(
      {
        ...campaign,
        repetitions: 2,
        arms: [{ id: "baseline" }, { id: "candidate", prompt: { harness: "task" } }],
        stages: [
          { id: "smoke", tags: ["smoke"], arms: ["baseline"], repetitions: 1, profiles: [codex] },
          { id: "full", taskIds: ["task-b"] },
        ],
      },
      suite,
    );

    expect(plan.trials.map((trial) => [trial.stage, trial.taskId, trial.profile.driver])).toEqual([
      ["smoke", "task-a", "codex"],
      ["full", "task-b", "claude"],
      ["full", "task-b", "claude"],
      ["full", "task-b", "claude"],
      ["full", "task-b", "claude"],
    ]);
  });

  it("narrows the plan to the stages, tags and task ids an operator names", () => {
    const staged = {
      ...campaign,
      stages: [{ id: "smoke", tags: ["smoke"] }, { id: "full" }],
    };

    const pick = (filters: Parameters<typeof planCampaign>[2]) =>
      planCampaign(staged, suite, filters).trials.map((trial) => `${trial.stage}:${trial.taskId}`);

    expect(pick({ stages: ["full"] })).toEqual(["full:task-a", "full:task-b"]);
    expect(pick({ tags: ["onboarding"] })).toEqual(["full:task-b"]);
    expect(pick({ taskIds: ["task-a"], stages: ["smoke"] })).toEqual(["smoke:task-a"]);
  });

  it("gives one task its own profiles over the stage's and the campaign's", () => {
    const plan = planCampaign(
      {
        ...campaign,
        tasks: { "task-a": { profiles: [{ ...claude, model: "opus" }] }, "task-b": {} },
      },
      suite,
    );

    expect(plan.trials.map((trial) => [trial.taskId, trial.profile.model])).toEqual([
      ["task-a", "opus"],
      ["task-b", "sonnet"],
    ]);
  });

  it("records an arm's prompt and skill overrides with their SHA-256", () => {
    const plan = planCampaign(
      {
        ...campaign,
        stages: [{ id: "one", taskIds: ["task-a"] }],
        arms: [
          {
            id: "short",
            prompt: { text: "Set up Tack in {{cwd}}.", source: "file:/tmp/short.md" },
            skills: {
              "use-tack/SKILL.md": { text: "replaced" },
              "use-tack/references/extra.md": { text: "added", source: "file:/tmp/extra.md" },
            },
          },
        ],
      },
      suite,
    );

    expect(plan.trials[0]).toMatchObject({
      arm: "short",
      prompt: {
        source: "file:/tmp/short.md",
        text: "Set up Tack in {{cwd}}.",
        sha256: digest("Set up Tack in {{cwd}}."),
      },
      skills: [
        {
          path: "use-tack/SKILL.md",
          source: "inline",
          text: "replaced",
          sha256: digest("replaced"),
        },
        {
          path: "use-tack/references/extra.md",
          source: "file:/tmp/extra.md",
          text: "added",
          sha256: digest("added"),
        },
      ],
    });
    const changed = planCampaign(
      {
        ...campaign,
        stages: [{ id: "one", taskIds: ["task-a"] }],
        arms: [{ id: "short", skills: { "use-tack/SKILL.md": { text: "other" } } }],
      },
      suite,
    );
    expect(changed.confirmation).not.toBe(plan.confirmation);
  });

  it("lets a campaign change one family's limits for its run", () => {
    const plan = planCampaign(
      { ...campaign, families: { quick: { wallSeconds: 300, budgetUsd: 0.5 } } },
      suite,
    );

    expect(plan.trials[0]?.limits).toEqual({
      wallSeconds: 300,
      toolCalls: 12,
      outputBytes: 4194304,
      budgetUsd: 0.5,
    });
  });

  it("estimates input tokens per user turn and sums the per-trial budgets", () => {
    const plan = planCampaign(
      { ...campaign, families: { quick: { budgetUsd: 0.5 } }, limits: { budgetUsd: 1.2 } },
      suite,
    );

    expect(plan.estimate).toEqual({
      userTurns: 4,
      inputTokens: { low: 120000, high: 600000, calibrated: false },
      trialBudgetsUsd: 1.5,
    });
    expect(plan.limits).toEqual({ trials: 12, wallSeconds: 960, budgetUsd: 1.2 });
    expect(planCampaign(campaign, suite, { taskIds: ["task-a"] }).estimate.trialBudgetsUsd).toBe(
      null,
    );
  });

  it("accepts more trials than the default only when the campaign raises its limit", () => {
    const many = { ...campaign, repetitions: 7 };

    expect(() => planCampaign(many, suite)).toThrow("Campaign plans 14 trials; its limit is 12");
    expect(planCampaign({ ...many, limits: { trials: 14 } }, suite).trials).toHaveLength(14);
  });

  it.each([
    ["follow-up messages", { taskIds: ["task-b"] }, {}, "codex cannot send follow-up messages"],
    [
      "a turn limit",
      { taskIds: ["task-a"] },
      { families: { quick: { maxTurns: 5 } } },
      "codex cannot enforce maxTurns",
    ],
    [
      "a budget",
      { taskIds: ["task-a"] },
      { families: { quick: { budgetUsd: 1 } } },
      "codex cannot enforce budgetUsd",
    ],
  ])("refuses a trial whose driver cannot honour its %s", (_case, filters, change, message) => {
    expect(() =>
      planCampaign({ ...campaign, profiles: [codex], ...change }, suite, filters),
    ).toThrow(message);
  });

  it.each([
    ["no profiles", { profiles: [] }, "Select explicit profiles"],
    ["profiles that are not a list", { profiles: "codex" }, "Select explicit profiles"],
    ["an unknown driver", { profiles: [{ ...claude, driver: "x" }] }, "Unsupported driver"],
    ["an empty model", { profiles: [{ ...claude, model: "" }] }, "Model and effort"],
    ["an unknown field", { extra: true }, "Unknown campaign field extra"],
    ["a negative seed", { seed: -1 }, "Invalid seed"],
    ["zero repetitions", { repetitions: 0 }, "Invalid repetitions"],
    ["a fractional repetition", { repetitions: 1.5 }, "Invalid repetitions"],
    ["the same profile twice", { profiles: [claude, claude] }, "Duplicate trial identity"],
    ["an unknown stage task", { stages: [{ id: "s", taskIds: ["missing"] }] }, "Unknown task"],
    ["a stage with no tasks", { stages: [{ id: "s", tags: ["none"] }] }, "No trials selected"],
    ["an unknown stage arm", { stages: [{ id: "s", arms: ["missing"] }] }, "Unknown arm missing"],
    ["duplicate stages", { stages: [{ id: "s" }, { id: "s" }] }, "Duplicate selection"],
    [
      "a stage task list that is not a list",
      { stages: [{ id: "s", taskIds: "task-a" }] },
      "Expected nonempty string list",
    ],
    ["a stage id that is not portable", { stages: [{ id: "Smoke Test" }] }, "Invalid id"],
    ["duplicate arms", { arms: [{ id: "a" }, { id: "a" }] }, "Duplicate selection"],
    ["an unknown arm field", { arms: [{ id: "a", text: "x" }] }, "Unknown arm field text"],
    [
      "an unknown harness prompt",
      { arms: [{ id: "a", prompt: { harness: "x" } }] },
      "Unknown harness prompt x",
    ],
    [
      "a prompt with an unknown placeholder",
      { arms: [{ id: "a", prompt: { text: "Use {{path}}" } }] },
      "Unknown prompt placeholder {{path}}",
    ],
    [
      "a skill path that escapes the built-ins",
      { arms: [{ id: "a", skills: { "../tack.yaml": { text: "x" } } }] },
      "Invalid skill path ../tack.yaml",
    ],
    [
      "a skill file without text",
      { arms: [{ id: "a", skills: { "use-tack/SKILL.md": { file: "x.md" } } }] },
      "Unknown text field file",
    ],
    ["an unknown family", { families: { missing: {} } }, "Unknown family missing"],
    ["an unknown limit", { families: { quick: { tokens: 1 } } }, "Unknown limit field tokens"],
    [
      "a limit above its ceiling",
      { families: { quick: { wallSeconds: 3601 } } },
      "Invalid limit wallSeconds",
    ],
    ["a zero budget", { limits: { budgetUsd: 0 } }, "Invalid limit budgetUsd"],
    ["an unknown task override", { tasks: { missing: {} } }, "Unknown task missing"],
    [
      "a stage naming one task twice",
      { stages: [{ id: "s", taskIds: ["task-a", "task-a"] }] },
      "Duplicate selection",
    ],
    ["prompt text that is not text", { arms: [{ id: "a", prompt: { text: 1 } }] }, "Expected text"],
    ["a trial limit above 200", { limits: { trials: 201 } }, "Invalid limit trials"],
  ])("refuses a campaign with %s", (_case, change, message) => {
    expect(() => planCampaign({ ...campaign, ...change }, suite)).toThrow(message);
  });

  it.each([
    [
      "an unknown family",
      { ...suite, tasks: [{ ...task, family: "missing" }] },
      "Unknown family missing",
    ],
    [
      "invalid family limits",
      {
        ...suite,
        families: [{ id: "quick", limits: { wallSeconds: 0, toolCalls: 1, outputBytes: 1 } }],
      },
      "Invalid limit wallSeconds",
    ],
    [
      "invalid criteria",
      { ...suite, tasks: [{ ...task, criteria: [] }] },
      "Invalid task criteria: task-a",
    ],
  ])("refuses a suite task with %s", (_case, broken, message) => {
    expect(() => planCampaign(campaign, broken, { taskIds: ["task-a"] })).toThrow(message);
  });
});

describe("scoring", () => {
  it("requires complete criterion evidence and preserves partial credit", () => {
    const criteria = [
      { criterionId: "answer", satisfied: true, evidence: ["answer"] },
      { criterionId: "evidence", satisfied: "unknown", evidence: [] },
    ] as const;
    expect(scoreGrade(task, { criteria, violatedInvariants: [] }, "completed")).toEqual({
      score: 0.75,
      pass: true,
      excluded: false,
    });
    expect(
      scoreGrade(task, { criteria, violatedInvariants: ["source changed"] }, "completed").pass,
    ).toBe(false);
    expect(scoreGrade(task, { criteria, violatedInvariants: [] }, "timed-out").pass).toBe(false);
    expect(scoreGrade(task, { criteria, violatedInvariants: [] }, "limit-reached")).toMatchObject({
      pass: false,
      excluded: false,
    });
    expect(scoreGrade(task, { criteria, violatedInvariants: [] }, "auth-required").excluded).toBe(
      true,
    );
    expect(() => scoreGrade(task, { criteria: [], violatedInvariants: [] }, "completed")).toThrow();
  });

  it("rejects malformed task criteria rather than guessing a score", () => {
    for (const invalid of [
      { ...task, criteria: [] },
      { ...task, criteria: [{ id: "answer", weight: -1, requiredForPass: true }] },
    ])
      expect(() =>
        scoreGrade(invalid, { criteria: [], violatedInvariants: [] }, "completed"),
      ).toThrow();
  });
});

it("fills every request and cwd placeholder once, without reading placeholders inside the values", () => {
  expect(
    renderPrompt("{{request}} in {{cwd}}, again {{cwd}}", {
      request: "Use {{cwd}}",
      cwd: "/world",
    }),
  ).toBe("Use {{cwd}} in /world, again /world");
});

describe("saved trial identity", () => {
  const [saved] = planCampaign(
    {
      ...campaign,
      arms: [{ id: "skills", skills: { "use-tack/SKILL.md": { text: "replaced" } } }],
    },
    suite,
    { taskIds: ["task-b"] },
  ).trials;

  it("decodes a planned trial exactly as the plan wrote it", () => {
    expect(plannedTrial(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it.each([
    ["no stage", { stage: undefined }, "Invalid saved trial stage"],
    ["a seed that is not a number", { seed: "1" }, "Invalid saved trial"],
    ["skills that are not a list", { skills: {} }, "Invalid saved trial"],
    ["an id that is not portable", { id: "../x" }, "Invalid saved trial id"],
  ])("refuses a saved trial with %s", (_case, change, message) => {
    expect(() => plannedTrial({ ...saved, ...change })).toThrow(message);
  });
});
