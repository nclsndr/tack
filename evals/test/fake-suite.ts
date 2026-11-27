import type { EvalTask, TaskSuite } from "../src/contract.ts";
const task: EvalTask = {
  taskId: "task-a",
  version: 1,
  title: "Fake discovery",
  difficulty: "easy",
  tags: ["smoke"],
  family: "quick",
  criteria: [{ id: "answer", weight: 1, requiredForPass: true }],
  prepare: async () => ({ cwd: "/world", request: "Find version", publicFacts: {} }),
  oracle: async () => ({ commands: [], finalAnswer: "correct" }),
  grade: async (context) => {
    await context.exec({ argv: ["test", "-d", "/world"], cwd: "/world" });
    return {
      criteria: [
        { criterionId: "answer", satisfied: context.finalAnswer === "correct", evidence: [] },
      ],
      violatedInvariants: [],
    };
  },
};
export const suite: TaskSuite = {
  contractVersion: 1,
  families: [{ id: "quick", limits: { wallSeconds: 120, outputBytes: 1024, toolCalls: 12 } }],
  tasks: [task, { ...task, taskId: "task-b", tags: ["full"] }],
};
