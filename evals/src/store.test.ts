import { expect, it } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCampaign, saveTrial } from "./store.ts";
import { plannedTrialFixture } from "./plan.test-support.ts";
it("reconstructs interrupted campaigns from per-trial records and keeps remaining cells unstarted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-store-"));
  const trial = plannedTrialFixture({ id: "first" });
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ plan: { trials: [trial, { ...trial, id: "second" }] } }),
  );
  await writeFile(
    join(directory, "first.json"),
    JSON.stringify({
      ...trial,
      outcome: "completed",
      score: 0,
      pass: false,
      excluded: false,
      grade: null,
      execution: null,
      error: null,
    }),
  );
  const results = await readCampaign(directory);
  expect(results.map((result) => result.outcome)).toEqual(["completed", "unstarted"]);
  expect(results[1]?.error).toContain("Interrupted");
});
it("publishes complete records atomically and does not hide corrupt final evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-save-"));
  const result = {
    ...plannedTrialFixture(),
    outcome: "unstarted",
    score: null,
    pass: false,
    excluded: true,
    grade: null,
    execution: null,
    error: null,
  } as const;
  await saveTrial(directory, result);
  expect(JSON.parse(await readFile(join(directory, "one.json"), "utf8"))).toEqual(result);
  await writeFile(join(directory, "results.json"), JSON.stringify([result]));
  expect(await readCampaign(directory)).toHaveLength(1);
  await writeFile(join(directory, "results.json"), "{");
  await expect(readCampaign(directory)).rejects.toThrow();
});

const plannedTrial = plannedTrialFixture({ id: "first" });
it("refuses to reconstruct a campaign whose manifest has no plan of trials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-store-plan-"));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ plan: {} }));

  await expect(readCampaign(directory)).rejects.toThrow("Missing campaign plan");
});
it.each([
  ["task", { taskId: "task-b" }],
  ["seed", { seed: 2 }],
  ["profile", { profile: { driver: "claude", model: "opus", effort: "low" } }],
  ["arm", { arm: "candidate" }],
  ["limits", { limits: { ...plannedTrial.limits, toolCalls: 99 } }],
])("refuses a saved trial record whose %s differs from the plan", async (_field, change) => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-store-identity-"));
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ plan: { trials: [plannedTrial] } }),
  );
  await writeFile(
    join(directory, "first.json"),
    JSON.stringify({
      ...plannedTrial,
      ...change,
      outcome: "completed",
      score: 1,
      pass: true,
      excluded: false,
      grade: null,
      execution: null,
      error: null,
    }),
  );

  await expect(readCampaign(directory)).rejects.toThrow(
    "Trial record does not match its planned identity",
  );
});
it("does not hide a corrupt per-trial record while reconstructing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-store-corrupt-"));
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ plan: { trials: [plannedTrial] } }),
  );
  await writeFile(join(directory, "first.json"), "{");

  await expect(readCampaign(directory)).rejects.toThrow(SyntaxError);
});
