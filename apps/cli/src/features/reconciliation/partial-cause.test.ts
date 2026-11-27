import { expect, it } from "vitest";
import { partialCauseDiagnostic } from "../../cli/envelope/partial-causes.ts";
import type { NamespaceDependencyResolution } from "../../domain/reconciliation/reconciliation-schema.ts";
import {
  reconciliationPlanCauses,
  removalCauses,
  resolutionCauses,
  selectionRootCauses,
} from "./partial-cause.ts";

const address = {
  kind: "skill",
  name: "review",
  sourceRegistrationId: "11111111-1111-4111-8111-111111111111",
} as const;
const namespace = { _tag: "project", projectName: "demo" } as const;

const causesOf = (blocker: "requested-missing" | "requested-quarantined") =>
  resolutionCauses([
    {
      namespace,
      resolution: { groups: [], optionalSkips: [], requestBlockers: [{ _tag: blocker, address }] },
    } satisfies NamespaceDependencyResolution,
  ]);

it.each([
  ["requested-missing", "missing"],
  ["requested-quarantined", "quarantined"],
] as const)("reports a %s request as %s, never as another reason", (blocker, reason) => {
  expect(causesOf(blocker)).toEqual([
    { code: "unresolved-choice", subject: { address, namespace, reason } },
  ]);
});

it("names what an unresolved include lacks in its message", () => {
  const [missing] = causesOf("requested-missing");
  expect(partialCauseDiagnostic(missing!).message).toBe(
    "An include choice names a resource that the catalog cannot provide.",
  );
});

it("names each missing root and each unhealthy root with its issue", () => {
  expect(
    selectionRootCauses({
      staleRoots: [{ canonicalPath: "/repo/gone", code: "root-missing", projectName: "demo" }],
      unhealthyRoots: [
        {
          canonicalPath: "/repo/file",
          code: "root-not-directory",
          message: "The root is a file.",
          projectName: "demo",
        },
      ],
    }),
  ).toEqual([
    { code: "root-missing", subject: { projectName: "demo", root: "/repo/gone" } },
    {
      code: "root-unhealthy",
      subject: {
        issue: { code: "root-not-directory", message: "The root is a file." },
        projectName: "demo",
        root: "/repo/file",
      },
    },
  ]);
});

it("names a link whose relative target cannot be derived with its address and destination", () => {
  const target = { _tag: "user", canonicalPath: "/home/operator" } as const;
  expect(
    reconciliationPlanCauses({
      kind: "skill-reconciliation-plan",
      namespaceResolutions: [],
      units: [
        {
          actions: [],
          adapter: "codex",
          collisions: [],
          conflicts: [
            {
              _tag: "relative-target-unavailable",
              address,
              destinationPath: "/home/operator/.agents/skills/review",
              sourceDirectoryPath: "D:/sources/review",
            },
          ],
          delivery: { command: "unsupported", skill: "delivered" },
          summary: {
            adopt: 0,
            blocked: 0,
            collision: 0,
            conflict: 1,
            create: 0,
            release: 0,
            remove: 0,
            retire: 0,
          },
          target,
        },
      ],
      version: 1,
    }),
  ).toEqual([
    {
      code: "relative-target-unavailable",
      subject: {
        adapter: "codex",
        target,
        address,
        destinationPath: "/home/operator/.agents/skills/review",
      },
    },
  ]);
});

it("keeps a docs mount whose removal did not apply as an owed removal", () => {
  const evidence = {
    projectName: "demo",
    root: "/repo",
    resource: { sourceRegistrationId: address.sourceRegistrationId, name: "notes" },
    destinationPath: "/repo/.tack/docs/notes",
    sourceDirectoryPath: "/sources/notes",
    relativeTarget: "../../../sources/notes",
  };
  const action = { action: "remove", evidence } as const;
  expect(
    removalCauses(
      [],
      [
        {
          actions: [],
          docsActions: [
            { _tag: "applied", action },
            { _tag: "skipped", action, reason: "recovery-pending" },
            { _tag: "failed", action, code: "filesystem-failure", message: "unlink failed" },
          ],
        },
      ],
    ),
  ).toEqual([
    {
      code: "removal-skipped",
      subject: { destinationPath: "/repo/.tack/docs/notes", reason: "recovery-pending" },
    },
    {
      code: "removal-failed",
      subject: { destinationPath: "/repo/.tack/docs/notes", reason: "unlink failed" },
    },
  ]);
});
