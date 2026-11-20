import { describe, expect, it } from "vitest";
import { environmentPrompt, evalPrompts } from "./evals.ts";
import { agentPrompt } from "./landing.ts";

describe("evalPrompts", () => {
  it("starts a trial from the task's own request or from the landing page's getting-started prompt", () => {
    expect(evalPrompts.task).toBe("{{request}}");
    expect(evalPrompts["getting-started"]).toBe(agentPrompt);
  });
});

describe("environmentPrompt", () => {
  it("names the one task tool, the task cwd and each installed skill with its description and path", () => {
    const prompt = environmentPrompt({
      cwd: "/world/projects/demo",
      skills: [
        {
          name: "use-tack",
          description: "Operate Tack.",
          path: "/instructions/skills/use-tack/SKILL.md",
        },
      ],
    });

    expect(prompt).toContain("mcp task exec");
    expect(prompt).toContain("Working directory: /world/projects/demo.");
    expect(prompt).toContain(
      "- use-tack: Operate Tack. Read /instructions/skills/use-tack/SKILL.md",
    );
  });

  it("says no skills are installed when the trial delivers none", () => {
    expect(environmentPrompt({ cwd: "/world", skills: [] })).toContain("No skills are installed.");
  });
});
