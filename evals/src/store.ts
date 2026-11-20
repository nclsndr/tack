import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { plannedTrial, record } from "./plan.ts";
import { savedResults } from "./report.ts";
import type { TrialResult } from "./campaign.ts";

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
/** Atomically publish a complete result while retaining native partial evidence separately. */
export async function saveTrial(directory: string, result: TrialResult): Promise<void> {
  const target = join(directory, `${result.id}.json`);
  await writeFile(`${target}.pending`, JSON.stringify(result, null, 2));
  await rename(`${target}.pending`, target);
}
/** Read final results or reconstruct a crash from the immutable plan and completed trial records. */
export async function readCampaign(directory: string): Promise<TrialResult[]> {
  try {
    return savedResults(JSON.parse(await readFile(join(directory, "results.json"), "utf8")));
  } catch (error) {
    if (missing(error) === false) throw error;
  }
  const manifest = record(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  const plan = record(manifest["plan"]);
  if (Array.isArray(plan["trials"]) === false) throw new Error("Missing campaign plan");
  const initial = savedResults(
    plan["trials"].map((trial) => ({
      ...record(trial),
      outcome: "unstarted",
      score: null,
      pass: false,
      excluded: true,
      grade: null,
      execution: null,
      error: "Interrupted campaign: inspect raw fixture evidence before retrying",
    })),
  );
  return await Promise.all(
    initial.map(async (trial) => {
      try {
        const saved = savedResults([
          JSON.parse(await readFile(join(directory, `${trial.id}.json`), "utf8")),
        ])[0];
        if (
          saved === undefined ||
          JSON.stringify(plannedTrial(saved)) !== JSON.stringify(plannedTrial(trial))
        )
          throw new Error("Trial record does not match its planned identity");
        return saved;
      } catch (error) {
        if (missing(error) === true) return trial;
        throw error;
      }
    }),
  );
}
