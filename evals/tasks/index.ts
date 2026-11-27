import type { TaskSuite } from "../src/contract.ts";
import { reportVersion } from "./example/report-version.ts";

/**
 * The checkout's own suite, which the runner loads when no `--suite` is named. It holds one
 * neutral example task that exercises the harness; the study scenarios come later.
 */
export const suite: TaskSuite = {
  contractVersion: 1,
  families: [
    {
      id: "example",
      limits: {
        wallSeconds: 180,
        toolCalls: 10,
        outputBytes: 1048576,
        maxTurns: 10,
        budgetUsd: 0.25,
      },
    },
  ],
  tasks: [reportVersion],
};
