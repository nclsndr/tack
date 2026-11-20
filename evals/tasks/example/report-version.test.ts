import { describe, expect, it } from "vitest";
import type { CommandRequest, TaskContext } from "../../src/contract.ts";
import { scoreGrade } from "../../src/plan.ts";
import { reportVersion } from "./report-version.ts";

const versionJson = JSON.stringify({ result: { kind: "version", version: "0.1.0" } });
/** A task context whose `tack` answers like the image's build, recording each command. */
const fakeContext = (stdout = versionJson, exitCode = 0) => {
  const seen: CommandRequest[] = [];
  const context: TaskContext = {
    seed: 1,
    world: "/tmp/world",
    exec: async (request) => {
      seen.push(request);
      return { exitCode, stdout, stderr: exitCode === 0 ? "" : "broken" };
    },
  };
  return { context, seen };
};

describe("report-version", () => {
  it("passes its own oracle", async () => {
    const { context } = fakeContext();
    const prepared = await reportVersion.prepare(context);
    const oracle = await reportVersion.oracle(context, prepared);
    const grade = await reportVersion.grade({
      ...context,
      prepared,
      ...oracle,
      outcome: "completed",
    });

    expect(scoreGrade(reportVersion, grade, "completed")).toEqual({
      score: 1,
      pass: true,
      excluded: false,
    });
  });

  it.each([
    ["a wrong version", "0.9.0", [{ argv: ["tack", "--version"], cwd: "/world" }], 0.2, false],
    ["the right version without running tack", " 0.1.0\n", [], 0.8, true],
    [
      "the right version from a tack process inside a shell",
      "0.1.0",
      [
        {
          argv: ["bash", "-c", "tack --version"],
          cwd: "/world",
          executions: [
            { argv: ["tack", "--version"], cwd: "/world", exitCode: 0, stdout: "", stderr: "" },
          ],
        },
      ],
      1,
      true,
    ],
  ])("scores %s", async (_case, finalAnswer, commands, score, pass) => {
    const { context } = fakeContext();
    const prepared = await reportVersion.prepare(context);
    const grade = await reportVersion.grade({
      ...context,
      prepared,
      commands: commands.map((command) => ({ exitCode: 0, stdout: "", stderr: "", ...command })),
      finalAnswer,
      outcome: "completed",
    });

    expect(scoreGrade(reportVersion, grade, "completed")).toMatchObject({ score, pass });
  });

  it.each([
    ["a failing tack", versionJson, 1],
    ["output that is not JSON", "Tack 0.1.0", 0],
  ])("refuses to prepare against %s", async (_case, stdout, exitCode) => {
    await expect(reportVersion.prepare(fakeContext(stdout, exitCode).context)).rejects.toThrow(
      "Cannot read the installed Tack version",
    );
  });
});
