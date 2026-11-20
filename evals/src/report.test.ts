import { expect, it } from "vitest";
import { renderReport, savedResults } from "./report.ts";
import type { TrialResult } from "./campaign.ts";
import { plannedTrialFixture } from "./plan.test-support.ts";

const execution = (metadata: Record<string, unknown>, costUsd: number | null = null) => ({
  outcome: "completed" as const,
  finalAnswer: "",
  commands: [],
  costUsd,
  metadata,
});
const result: TrialResult = {
  ...plannedTrialFixture(),
  outcome: "completed",
  score: 0.5,
  pass: false,
  excluded: false,
  grade: { criteria: [], violatedInvariants: [] },
  execution: execution({}),
  error: null,
};

it("shows each trial, infrastructure exclusions and unknown usage without inventing zero", () => {
  const report = renderReport([
    result,
    { ...result, id: "two", outcome: "unstarted", score: null, excluded: true, execution: null },
  ]);
  expect(report).toContain("0.50");
  expect(report).toContain("unstarted");
  expect(report).toContain("unknown");
  expect(report).toContain("one.json");
  expect(report).toContain("1 fresh scored");
  expect(report).toContain("Reported API-equivalent spend: $0.00 over 0 of 1 launched trials.");
});

it("shows each trial's stage, arm, user turns, Tack commands and reported spend", () => {
  const report = renderReport([
    {
      ...plannedTrialFixture({ stage: "smoke", arm: "short", followUps: 2 }),
      ...result,
      stage: "smoke",
      arm: "short",
      followUps: 2,
      execution: execution(
        { userTurns: 2, nativeTurns: 9, tackCommandCount: 4, failedTackCommands: 1 },
        0.25,
      ),
    },
    { ...result, id: "two", execution: execution({}, 0.5) },
  ]);

  expect(report).toContain("| smoke | task-a |");
  expect(report).toContain("| short | 1 | completed | fail | 0.50 | unknown | 2 / 3 | 9 | 4 / 1 |");
  expect(report).toContain("| 0.25 | [evidence](one.json) |");
  expect(report).toContain("Reported API-equivalent spend: $0.75 over 2 of 2 launched trials.");
});

it("validates saved evidence before linking or mounting fixtures", () => {
  const saved = {
    ...plannedTrialFixture(),
    outcome: "completed",
    score: 1,
    pass: true,
    excluded: false,
    error: null,
    execution: {
      outcome: "completed",
      finalAnswer: "correct",
      commands: [{ argv: ["tack"], cwd: "/world", stdout: "ok", stderr: "", exitCode: 0 }],
      costUsd: 0.1,
      metadata: {
        budgetDenials: { toolCalls: 2, outputBytes: 1, busy: 0 },
        nativeOutputLimit: false,
        usage: { input: 12, cachedInput: 2, output: 1, complete: true, costUsd: null },
      },
    },
  };
  expect(savedResults([saved])[0]?.execution?.commands).toEqual(saved.execution.commands);
  expect(savedResults([saved])[0]?.execution?.costUsd).toBe(0.1);
  expect(renderReport(savedResults([saved]))).toContain("2 / 1 / 0 | false");
  const nested = { ...saved.execution.commands[0], executions: saved.execution.commands };
  expect(
    savedResults([{ ...saved, execution: { ...saved.execution, commands: [nested] } }])[0]
      ?.execution?.commands,
  ).toEqual([nested]);
  expect(savedResults([{ ...saved, execution: null }])[0]?.execution).toBe(null);
  expect(
    savedResults([{ ...saved, execution: { ...saved.execution, costUsd: null } }])[0]?.execution
      ?.costUsd,
  ).toBe(null);
  expect(renderReport(savedResults([saved]))).toContain("12 / 2 / unknown / 1 / unknown");
  expect(() => savedResults({})).toThrow();
  expect(() => savedResults([{ ...saved, id: "../escape" }])).toThrow();
  expect(() => savedResults([{ ...saved, outcome: "lost" }])).toThrow("Invalid saved result");
  for (const broken of [{ commands: "bad" }, { commands: [{}] }, { costUsd: "free" }])
    expect(() =>
      savedResults([{ ...saved, execution: { ...saved.execution, ...broken } }]),
    ).toThrow();
  expect(() =>
    savedResults([{ ...saved, prompt: { ...saved.prompt, text: "edited after the run" } }]),
  ).toThrow("Invalid saved agent text");
});

it("shows the agent version recorded in each trial's image identity", () => {
  const versioned: TrialResult = {
    ...result,
    execution: execution({
      image: { id: "sha256:x", agentVersions: { claude: "2.1.0 (Claude Code)" } },
    }),
  };

  expect(renderReport([versioned])).toContain("| claude (2.1.0 (Claude Code)) |");
  const unversioned = { ...result, execution: execution({ image: { id: "sha256:x" } }) };
  expect(renderReport([unversioned])).toContain("| claude (unknown) |");
});
