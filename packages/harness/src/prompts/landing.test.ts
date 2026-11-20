import { expect, it } from "vitest";
import { agentPrompt } from "./landing.ts";

it("has the agent install the published CLI, read the onboarding guide first and wait for a yes before each write", () => {
  expect(agentPrompt).toContain(
    "Install Tack with `npm install --global @tackup/cli`, then run `tack guide onboarding` and follow it",
  );
  // The guide asks before `tack init` writes, so the prompt does not run it first.
  expect(agentPrompt).not.toContain("tack init");
  expect(agentPrompt).toContain("wait for my yes before you apply it");
});
