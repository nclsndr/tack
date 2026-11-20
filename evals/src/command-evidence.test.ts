import { expect, it } from "vitest";
import { commandEvidence } from "./command-evidence.ts";
const command = { argv: ["tack", "catalog"], cwd: "/world", exitCode: 0, stdout: "{}", stderr: "" };
it("retains individual process observations and refuses incomplete or malformed proof", () => {
  expect(commandEvidence({ ...command, executions: [command] })).toEqual({
    ...command,
    executions: [command],
  });
  for (const invalid of [
    null,
    {},
    { ...command, argv: [1] },
    { ...command, cwd: 1 },
    { ...command, exitCode: "0" },
    { ...command, stdout: null },
    { ...command, stderr: 1 },
    { ...command, truncated: true },
    { ...command, executions: {} },
    { ...command, executions: [{}] },
  ]) {
    expect(() => commandEvidence(invalid)).toThrow();
  }
});
