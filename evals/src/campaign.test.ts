import { expect, it } from "vitest";
import { executeCampaign } from "./campaign.ts";
import { planCampaign } from "./plan.ts";
import type { CampaignBackend, Fixture } from "./campaign.ts";
import type { EvalTask, TaskContext, TaskSuite } from "./contract.ts";

const task: EvalTask = {
  taskId: "task-a",
  version: 1,
  title: "Test",
  difficulty: "easy",
  tags: [],
  family: "quick",
  criteria: [{ id: "answer", weight: 1, requiredForPass: true }],
  prepare: async () => ({ cwd: "/world", request: "find", publicFacts: {} }),
  grade: async (context) => ({
    criteria: [
      { criterionId: "answer", satisfied: context.finalAnswer === "correct", evidence: [] },
    ],
    violatedInvariants: [],
  }),
  oracle: async () => ({ commands: [], finalAnswer: "correct" }),
};
const suite: TaskSuite = {
  contractVersion: 2,
  families: [{ id: "quick", limits: { wallSeconds: 120, toolCalls: 12, outputBytes: 1024 } }],
  tasks: [task],
};
const plan = planCampaign(
  { profiles: [{ driver: "claude", model: "test", effort: "low" }], seed: 1 },
  suite,
);
const completed = {
  outcome: "completed",
  finalAnswer: "correct",
  commands: [],
  costUsd: null,
  metadata: {},
} as const;

it("requires confirmation, proves the oracle before launching and saves task failure separately", async () => {
  const order: string[] = [];
  const fixture: Fixture = {
    context: {
      seed: 1,
      world: "/temporary/world",
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
    close: async () => {
      order.push("close");
    },
  };
  const backend: CampaignBackend = {
    fixture: async (_trial, _task, purpose) => {
      order.push(purpose);
      return fixture;
    },
    launch: async () => {
      order.push("launch");
      return { ...completed, finalAnswer: "wrong" };
    },
    record: async (result) => {
      order.push(`record:${result.pass}`);
    },
  };
  await expect(executeCampaign({ plan, suite, confirmation: "wrong", backend })).rejects.toThrow(
    "confirmation",
  );
  expect(order).toEqual([]);
  const results = await executeCampaign({ plan, suite, confirmation: plan.confirmation, backend });
  expect(order).toEqual(["oracle", "close", "agent", "launch", "record:false", "close"]);
  expect(results[0]).toMatchObject({
    score: 0,
    pass: false,
    excluded: false,
    outcome: "completed",
  });
});
it("rejects an invalid oracle before any paid launch", async () => {
  const invalid = { ...task, oracle: async () => ({ commands: [], finalAnswer: "wrong" }) };
  let launched = false;
  const backend: CampaignBackend = {
    fixture: async () => ({
      context: {
        seed: 1,
        world: "/tmp/world",
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      close: async () => {},
    }),
    launch: async () => {
      launched = true;
      throw new Error("must not launch");
    },
    record: async () => {},
  };
  await expect(
    executeCampaign({
      plan,
      suite: { ...suite, tasks: [invalid] },
      confirmation: plan.confirmation,
      backend,
    }),
  ).rejects.toThrow("Oracle");
  expect(launched).toBe(false);
});
it("retains every unstarted cell on cancellation without launching or preparing", async () => {
  const controller = new AbortController();
  controller.abort();
  let touched = false;
  const records: string[] = [];
  const backend: CampaignBackend = {
    fixture: async () => {
      touched = true;
      throw new Error("must not prepare");
    },
    launch: async () => {
      touched = true;
      throw new Error("must not launch");
    },
    record: async (result) => {
      records.push(result.outcome);
    },
  };
  const results = await executeCampaign({
    plan,
    suite,
    confirmation: plan.confirmation,
    backend,
    signal: controller.signal,
  });
  expect(touched).toBe(false);
  expect(results).toHaveLength(plan.trials.length);
  expect(records).toEqual(["unstarted"]);
});
it("records infrastructure failures and prevents later launches", async () => {
  let count = 0;
  const backend: CampaignBackend = {
    fixture: async () => ({
      context: {
        seed: 1,
        world: "/tmp/world",
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      close: async () => {},
    }),
    launch: async () => {
      count += 1;
      throw new Error("client protocol failed");
    },
    record: async () => {},
  };
  const expanded = {
    ...plan,
    trials: plan.trials.flatMap((trial) => [trial, { ...trial, id: "second" }]),
  };
  const results = await executeCampaign({
    plan: expanded,
    suite,
    confirmation: expanded.confirmation,
    backend,
  });
  expect(results.map((result) => result.outcome)).toEqual(["setup-error", "unstarted"]);
  expect(count).toBe(1);
});
it("does not start an agent when cancellation arrives during fixture preparation", async () => {
  const controller = new AbortController();
  let launched = false;
  const cancellingTask = {
    ...task,
    prepare: async (context: TaskContext) => {
      if (context.world === "agent") controller.abort();
      return { cwd: "/world", request: "find", publicFacts: {} };
    },
  };
  const backend: CampaignBackend = {
    fixture: async (_trial, _task, purpose) => ({
      context: {
        world: purpose,
        seed: 1,
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      close: async () => {},
    }),
    launch: async () => {
      launched = true;
      return { ...completed, outcome: "cancelled", finalAnswer: "" };
    },
    record: async () => {},
  };
  await executeCampaign({
    plan,
    suite: { ...suite, tasks: [cancellingTask] },
    confirmation: plan.confirmation,
    backend,
    signal: controller.signal,
  });
  expect(launched).toBe(false);
});
it("closes the task container even if saving its result fails", async () => {
  let closed = 0;
  const backend: CampaignBackend = {
    fixture: async () => ({
      context: {
        world: "/tmp/world",
        seed: 1,
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      close: async () => {
        closed += 1;
      },
    }),
    launch: async () => completed,
    record: async () => {
      throw new Error("disk full");
    },
  };
  await expect(
    executeCampaign({ plan, suite, confirmation: plan.confirmation, backend }),
  ).rejects.toThrow("disk full");
  expect(closed).toBe(2);
});
it("refuses a plan naming a task the suite no longer has before preparing anything", async () => {
  let prepared = false;
  const backend: CampaignBackend = {
    fixture: async () => {
      prepared = true;
      throw new Error("must not prepare");
    },
    launch: async () => {
      throw new Error("must not launch");
    },
    record: async () => {},
  };

  await expect(
    executeCampaign({
      plan,
      suite: { ...suite, tasks: [] },
      confirmation: plan.confirmation,
      backend,
    }),
  ).rejects.toThrow("Missing task task-a");
  expect(prepared).toBe(false);
});
it("aborts a launch that outlives the campaign wall time", async () => {
  const backend: CampaignBackend = {
    fixture: async () => ({
      context: {
        world: "/tmp/world",
        seed: 1,
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      close: async () => {},
    }),
    launch: async (_trial, _task, _fixture, _prepared, signal) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { ...completed, outcome: "cancelled", finalAnswer: "" };
    },
    record: async () => {},
  };
  const expired = { ...plan, limits: { ...plan.limits, wallSeconds: 0 } };

  const results = await executeCampaign({
    plan: expired,
    suite,
    confirmation: expired.confirmation,
    backend,
  });

  expect(results.map((result) => result.outcome)).toEqual(["cancelled"]);
});

const fixedFixture =
  (log: string[] = []): CampaignBackend["fixture"] =>
  async (trial, _task, purpose) => {
    log.push(`${purpose}:${trial.arm}`);
    return {
      context: {
        world: "/tmp/world",
        seed: trial.seed,
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      close: async () => {},
    };
  };

it("proves the oracle again for an arm that changes the built-in skills", async () => {
  const log: string[] = [];
  const armed = planCampaign(
    {
      profiles: [{ driver: "claude", model: "test", effort: "low" }],
      seed: 1,
      arms: [
        { id: "baseline" },
        { id: "prompt", prompt: { text: "{{request}}!" } },
        { id: "skills", skills: { "use-tack/SKILL.md": { text: "changed" } } },
      ],
    },
    suite,
  );

  await executeCampaign({
    plan: armed,
    suite,
    confirmation: armed.confirmation,
    backend: { fixture: fixedFixture(log), launch: async () => completed, record: async () => {} },
  });

  expect(log.filter((entry) => entry.startsWith("oracle"))).toEqual([
    "oracle:baseline",
    "oracle:skills",
  ]);
});

it("stops launching once reported spend reaches the campaign budget, charging unknown cost at the trial budget", async () => {
  const budgeted = planCampaign(
    {
      profiles: [{ driver: "claude", model: "test", effort: "low" }],
      seed: 1,
      repetitions: 4,
      families: { quick: { budgetUsd: 0.5 } },
      limits: { budgetUsd: 1.2 },
    },
    suite,
  );
  const costs = [0.4, null, 0.4, 0.4];
  const records: string[] = [];

  const results = await executeCampaign({
    plan: budgeted,
    suite,
    confirmation: budgeted.confirmation,
    backend: {
      fixture: fixedFixture(),
      launch: async () => ({ ...completed, costUsd: costs.shift() ?? null }),
      record: async (result) => {
        records.push(result.outcome);
      },
    },
  });

  expect(results.map((result) => result.outcome)).toEqual([
    "completed",
    "completed",
    "completed",
    "unstarted",
  ]);
  expect(results[3]?.error).toBe("Campaign budget reached: $1.30 of $1.20");
  expect(records).toHaveLength(4);
});
