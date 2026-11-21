import { agentAdapterDescriptors } from "@tackup/cli/core";
import { describe, expect, it } from "vitest";

import { features } from "./content.ts";

describe("features.agents.links", () => {
  it("shows one project skill link per CLI adapter, at the adapter's own folder", () => {
    // The landing page cannot import the CLI eagerly, so its figure repeats the adapter table and
    // this test keeps the two in step.
    const skill = features.agents.links.source.split("/").at(-1);
    expect(features.agents.links.destinations.map((link) => link.path)).toEqual(
      agentAdapterDescriptors.map((adapter) => [...adapter.projectSkillDirectory, skill].join("/")),
    );
  });
});
