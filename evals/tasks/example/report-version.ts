import type { EvalTask, TaskContext } from "../../src/contract.ts";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))[key]
    : undefined;
/** The installed Tack's version, read from its own JSON output inside the task container. */
const installedVersion = async (context: TaskContext): Promise<string> => {
  const observed = await context.exec({ argv: ["tack", "--json", "--version"], cwd: "/world" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(observed.stdout);
  } catch {
    parsed = undefined;
  }
  const version = field(field(parsed, "result"), "version");
  if (observed.exitCode !== 0 || typeof version !== "string")
    throw new Error(`Cannot read the installed Tack version: ${observed.stderr}`);
  return version;
};

/**
 * A neutral example that exercises the harness end to end, not a Tack behaviour under study: the
 * agent reports the installed Tack version. One short user turn, a handful of commands.
 */
export const reportVersion: EvalTask = {
  taskId: "report-version",
  version: 1,
  title: "Report the installed Tack version",
  difficulty: "easy",
  tags: ["example", "smoke"],
  family: "example",
  criteria: [
    { id: "version-answered", weight: 0.8, requiredForPass: true },
    { id: "version-observed", weight: 0.2, requiredForPass: false },
  ],
  prepare: async (context) => {
    await installedVersion(context);
    return {
      cwd: "/world",
      request: "Which version of Tack is installed? Answer with the version number only.",
      publicFacts: {},
    };
  },
  oracle: async (context) => {
    const command = { argv: ["tack", "--version"], cwd: "/world" };
    const result = await context.exec(command);
    return { commands: [{ ...command, ...result }], finalAnswer: await installedVersion(context) };
  },
  grade: async (context) => {
    const version = await installedVersion(context);
    const ranTack = context.commands.some(
      (command) =>
        command.argv[0] === "tack" ||
        (command.executions ?? []).some((execution) => execution.argv[0] === "tack"),
    );
    return {
      criteria: [
        {
          criterionId: "version-answered",
          satisfied: context.finalAnswer.trim() === version,
          evidence: [`expected ${version}`, `answered ${context.finalAnswer.trim()}`],
        },
        {
          criterionId: "version-observed",
          satisfied: ranTack,
          evidence: [ranTack ? "ran tack" : "never ran tack"],
        },
      ],
      violatedInvariants: [],
    };
  },
};
