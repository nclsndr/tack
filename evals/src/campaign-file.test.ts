import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCampaign } from "./campaign-file.ts";

const withCampaign = async (campaign: (directory: string) => unknown) => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-campaign-file-"));
  await mkdir(join(directory, "overrides"));
  await writeFile(join(directory, "overrides/prompt.md"), "Set up {{cwd}}.");
  await writeFile(join(directory, "overrides/skill.md"), "Replaced skill.");
  const path = join(directory, "campaign.json");
  await writeFile(path, JSON.stringify(campaign(directory)));
  return { directory, path };
};

it("inlines each arm's prompt and skill files, resolved against the campaign's folder", async () => {
  const { directory, path } = await withCampaign((folder) => ({
    seed: 1,
    arms: [
      { id: "baseline" },
      {
        id: "short",
        prompt: { file: "overrides/prompt.md" },
        skills: {
          "use-tack/SKILL.md": { file: join(folder, "overrides/skill.md") },
          "use-tack/extra.md": { text: "inline" },
        },
      },
      { id: "harness", prompt: { harness: "getting-started" } },
    ],
  }));

  expect(await loadCampaign(path)).toEqual({
    seed: 1,
    arms: [
      { id: "baseline" },
      {
        id: "short",
        prompt: {
          text: "Set up {{cwd}}.",
          source: `file:${join(directory, "overrides/prompt.md")}`,
        },
        skills: {
          "use-tack/SKILL.md": {
            text: "Replaced skill.",
            source: `file:${join(directory, "overrides/skill.md")}`,
          },
          "use-tack/extra.md": { text: "inline" },
        },
      },
      { id: "harness", prompt: { harness: "getting-started" } },
    ],
  });
});

it.each([
  ["a campaign without arms", { seed: 1 }],
  ["a campaign that is not an object", [1]],
  ["an arm that is not an object", { arms: ["baseline"] }],
])("leaves %s for the planner to judge", async (_case, campaign) => {
  const { path } = await withCampaign(() => campaign);

  expect(await loadCampaign(path)).toEqual(campaign);
});

it("refuses an override that names both a file and its text", async () => {
  const { path } = await withCampaign(() => ({
    arms: [{ id: "a", prompt: { file: "overrides/prompt.md", text: "x" } }],
  }));

  await expect(loadCampaign(path)).rejects.toThrow("names one file path, or gives its text");
});
