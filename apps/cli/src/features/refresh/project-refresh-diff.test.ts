import { expect, it } from "vitest";
import { runtimeFixture } from "../../../test/support/state-fixture.ts";
import type { ManagedLinkEvidence } from "../../domain/links/managed-link-schema.ts";
import { unaccountedProjectEvidenceRoots } from "./project-refresh-diff.ts";

const evidence = (name: string, target: ManagedLinkEvidence["target"]): ManagedLinkEvidence => ({
  adapter: "codex",
  address: { kind: "skill", name, sourceRegistrationId: "00000000-0000-4000-8000-000000000001" },
  sourceDirectoryPath: `/sources/${name}`,
  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  target,
});

it("finds only the named project's evidence at roots a final plan does not account for", () => {
  const state = runtimeFixture({
    data: {
      agentLinks: [
        evidence("accounted", { _tag: "project-root", canonicalPath: "/repo/a", projectName: "p" }),
        evidence("stray", { _tag: "project-root", canonicalPath: "/repo/z", projectName: "p" }),
        evidence("other", { _tag: "project-root", canonicalPath: "/repo/y", projectName: "q" }),
        evidence("user", { _tag: "user", canonicalPath: "/home/operator" }),
      ],
      pendingRemovals: [
        {
          cause: "project-removal",
          evidence: evidence("owed", {
            _tag: "project-root",
            canonicalPath: "/repo/x",
            projectName: "p",
          }),
        },
      ],
    },
  });
  expect(unaccountedProjectEvidenceRoots(state, "p", ["/repo/a"])).toEqual(["/repo/x", "/repo/z"]);
  expect(unaccountedProjectEvidenceRoots(state, "p", ["/repo/a", "/repo/x", "/repo/z"])).toEqual(
    [],
  );
});
