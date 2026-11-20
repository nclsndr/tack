import { expect, it } from "vitest";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import {
  StatusReportSchema,
  type StatusNamespace,
  type StatusProject,
  type StatusReport,
} from "../../domain/status/status-schema.ts";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import { statusPartialCauses } from "./status.ts";

/** A complete status report of a project with drifted links and quarantined candidates. */
const trouble = Schema.decodeUnknownSync(StatusReportSchema)(
  JSON.parse(
    readFileSync(new URL("../../../test/fixtures/status-report-trouble.json", import.meta.url), {
      encoding: "utf8",
    }),
  ),
);
const [namespace] = trouble.namespaces;
const [project] = trouble.projects;
const [destination] = trouble.destinations;
if (namespace === undefined || project === undefined || destination?.evidence === undefined)
  throw new Error("The trouble fixture lost its namespace, project or destination evidence.");
const { evidence } = destination;

/** A report whose only causes are the ones a test adds. */
const calm: StatusReport = {
  ...trouble,
  catalog: { ...trouble.catalog, issues: [] },
  destinations: trouble.destinations.filter(({ _tag }) => _tag === "matching"),
};

const causesOf = (overrides: Partial<StatusReport>) =>
  statusPartialCauses({ ...calm, ...overrides });

it("has no cause for a report with matching links and nothing owed", () => {
  expect(statusPartialCauses(calm)).toEqual([]);
  expect(statusPartialCauses(trouble).length).toBeGreaterThan(0);
});

it("names unresolved profile inventories and incomplete profile delivery", () => {
  const withProfile = (issues: ReadonlyArray<string>, incomplete: boolean): StatusNamespace => ({
    ...namespace,
    profile: {
      application: {
        namespace: namespace.namespace,
        profileName: "team",
        sourceRegistrationId: evidence.sourceRegistrationId,
        direct: [],
        inventory: [],
        targets: [],
      },
      issues,
      delivery: { notes: [], issues: ["script run: not delivered"], incomplete },
    },
  });
  expect(causesOf({ namespaces: [withProfile([], false)] })).toEqual([]);
  expect(causesOf({ namespaces: [withProfile(["team lost a member"], true)] })).toEqual([
    {
      code: "profile-inventory-unresolved",
      subject: { namespace: namespace.namespace, issues: ["team lost a member"] },
    },
    {
      code: "profile-delivery-incomplete",
      subject: { namespace: namespace.namespace, issues: ["script run: not delivered"] },
    },
  ]);
});

it("names every project, anchor and root that is removing, missing or unhealthy", () => {
  const damaged: StatusProject = {
    anchor: { path: "/fx/demo/.git", status: "unhealthy", issue: { code: "x", message: "gone" } },
    lifecycle: "removing",
    name: "demo",
    roots: [
      {
        health: "missing",
        issue: { code: "root-missing", message: "gone" },
        lifecycle: "removing",
        path: "/fx/a",
      },
      {
        health: "unhealthy",
        issue: { code: "root-not-directory", message: "a file" },
        lifecycle: "active",
        path: "/fx/b",
      },
    ],
  };
  const suspended: StatusNamespace = { ...namespace, lifecycle: "suspended-removing" };
  expect(causesOf({ projects: [damaged], namespaces: [suspended] })).toEqual([
    { code: "project-removing", subject: { projectName: "demo" } },
    {
      code: "project-anchor-unhealthy",
      subject: {
        issue: { code: "x", message: "gone" },
        path: "/fx/demo/.git",
        projectName: "demo",
      },
    },
    { code: "root-removing", subject: { projectName: "demo", root: "/fx/a" } },
    { code: "root-missing", subject: { projectName: "demo", root: "/fx/a" } },
    {
      code: "root-unhealthy",
      subject: {
        projectName: "demo",
        root: "/fx/b",
        issue: { code: "root-not-directory", message: "a file" },
      },
    },
    { code: "project-removing", subject: { projectName: "demo" } },
  ]);
  // A user namespace is never suspended for a project removal.
  const user: StatusNamespace = {
    ...suspended,
    namespace: { _tag: "user" },
    selection: { ...suspended.selection, namespace: { _tag: "user" } },
    choices: [],
  };
  expect(causesOf({ namespaces: [user] })).toEqual([]);
});

it("names undelivered resources without adapters, owed removals and import problems", () => {
  const [address] = namespace.desired;
  if (address === undefined) throw new Error("The fixture namespace lost its desired addresses.");
  const undelivered: StatusNamespace = {
    ...namespace,
    undelivered: [{ address, reason: "no-enabled-adapter" }],
  };
  const causes = causesOf({
    namespaces: [undelivered],
    pendingRemovals: [
      { cause: "clean", evidence, destinationPath: managedLinkDestinationPath(evidence) },
    ],
    docsPendingRemovals: [
      {
        cause: "reset",
        evidence: {
          projectName: "demo",
          root: "/fx/demo",
          resource: { sourceRegistrationId: evidence.sourceRegistrationId, name: "notes" },
          destinationPath: "/fx/demo/.tack/docs/notes",
          sourceDirectoryPath: "/fx/source/notes",
          relativeTarget: "../../../source/notes",
        },
      },
    ],
    imports: {
      total: 1,
      locallyChanged: 0,
      problems: [
        {
          code: "imports-invalid",
          source: "personal-brain",
          registrationId: evidence.sourceRegistrationId,
          message: "imports: expected a list",
        },
      ],
    },
  });
  expect(causes.map(({ code }) => code)).toEqual([
    "no-adapters-enabled",
    "pending-removal",
    "pending-removal",
    "imports-invalid",
  ]);
  expect(causes.slice(1)).toEqual([
    {
      code: "pending-removal",
      subject: { cause: "clean", destinationPath: managedLinkDestinationPath(evidence) },
    },
    {
      code: "pending-removal",
      subject: { cause: "reset", destinationPath: "/fx/demo/.tack/docs/notes" },
    },
    {
      code: "imports-invalid",
      subject: {
        source: "personal-brain",
        registrationId: evidence.sourceRegistrationId,
        message: "imports: expected a list",
      },
    },
  ]);
});
