import { expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { parseInvocation } from "../../cli/commands/index.ts";
import { Effect, Schema } from "effect";
import { readFileSync } from "node:fs";
import {
  StatusReportSchema,
  type StatusDestination,
  type StatusNamespace,
  type StatusProject,
  type StatusReport,
  type StatusSource,
} from "../../domain/status/status-schema.ts";
import type { CatalogIssue } from "../../domain/sources/catalog-report.ts";
import {
  adaptersCheck,
  identityChecks,
  linksCheck,
  projectsCheck,
  sourcesCheck,
} from "./doctor-observations.ts";
import type { CheckoutObservation } from "../projects/checkout.ts";

/** A complete status report of a project with drifted links and quarantined candidates. */
const trouble = Schema.decodeUnknownSync(StatusReportSchema)(
  JSON.parse(
    readFileSync(new URL("../../../test/fixtures/status-report-trouble.json", import.meta.url), {
      encoding: "utf8",
    }),
  ),
);
/** Every command a check names, so the last test can parse each one. */
const named: Array<ReadonlyArray<string>> = [];
const next = (argv: ReadonlyArray<string>) => {
  named.push(argv);
  return argv;
};
const sourceId = "0d5b3402-2162-4620-ae41-ddc81538eb23";
const healthy = trouble.destinations.filter(({ _tag }) => _tag === "matching");
const [firstDestination] = healthy;
const [firstProject] = trouble.projects;
const [firstNamespace] = trouble.namespaces;
const [firstSource] = trouble.sources;
if (firstDestination === undefined || firstProject === undefined || firstNamespace === undefined)
  throw new Error("The trouble fixture lost its destinations, project or namespace.");
if (firstSource === undefined) throw new Error("The trouble fixture lost its sources.");

/** The trouble fixture's first source is the built-in one, which the operator never registers. */
const builtIns = new Set([firstSource.registration.id]);

const report = (overrides: Partial<StatusReport>): StatusReport => ({ ...trouble, ...overrides });

const outside: CheckoutObservation = { _tag: "outside-repository" };

const userTarget = { _tag: "user", canonicalPath: "/home/operator" } as const;

const destination = (
  _tag: StatusDestination["_tag"],
  destinationPath: string,
  target: StatusDestination["target"] = firstDestination.target,
): StatusDestination => ({ ...firstDestination, _tag, destinationPath, target });

const registration = (canonicalPath: string, index: number) => ({
  canonicalPath,
  id: `00000000-0000-4000-8000-00000000000${index}`,
});

const resourceIssue = (sourcePath: string, code: string, message = `${code} message`) =>
  ({
    code,
    message,
    subject: {
      _tag: "resource",
      candidatePath: `${sourcePath}/candidate`,
      sourcePath,
      sourceRegistrationId: sourceId,
    },
  }) satisfies CatalogIssue;

it("warns without adapters and fails when a destination could not be observed", () => {
  expect(adaptersCheck(report({ enabledAdapters: [] }), next)).toEqual({
    id: "adapters",
    outcome: "warning",
    message:
      "No agent adapter is enabled, so nothing is delivered. tack init enables the agents it finds in your home.",
    next: ["tack", "init"],
  });
  expect(adaptersCheck(trouble, next)).toEqual({
    id: "adapters",
    outcome: "ok",
    message: "Enabled: claude, codex.",
    subjects: ["claude", "codex"],
  });
  const unobserved = report({
    destinations: [
      destination("observation-failed", "/fx/b"),
      destination("observation-failed", "/fx/a"),
      destination("matching", "/fx/c"),
    ],
  });
  expect(adaptersCheck(unobserved, next)).toEqual({
    id: "adapters",
    outcome: "failed",
    message: "2 adapter destinations could not be observed.",
    subjects: ["/fx/a", "/fx/b"],
  });
});

it("fails on unhealthy sources and carries the message of a source that declares nothing", () => {
  const unhealthy = (
    canonicalPath: string,
    index: number,
    code: Extract<StatusSource, { status: "unhealthy" }>["issue"]["code"],
    message: string,
  ): StatusSource => ({
    issue: { code, message },
    registration: registration(canonicalPath, index),
    status: "unhealthy",
  });
  const moved = unhealthy("/fx/moved", 1, "source-location-changed", "It moved.");
  const undeclared = unhealthy(
    "/fx/old",
    2,
    "declaration-resources-undeclared",
    "Declare the skills of /fx/old in its tack.yaml.",
  );
  expect(
    sourcesCheck(report({ sources: [firstSource, undeclared, moved] }), builtIns, next),
  ).toEqual({
    id: "sources",
    outcome: "failed",
    message:
      "2 registered sources of 2 unhealthy; inspect them, then relocate or remove what moved. Declare the skills of /fx/old in its tack.yaml.",
    subjects: ["/fx/moved", "/fx/old"],
    next: ["tack", "source"],
  });
  expect(sourcesCheck(report({ sources: [moved] }), builtIns, next).message).toBe(
    "1 registered source of 1 unhealthy; inspect them, then relocate or remove what moved.",
  );
  const brokenBuiltIn = {
    ...unhealthy("/fx/builtins", 3, "source-location-changed", "It moved."),
    registration: firstSource.registration,
  };
  expect(sourcesCheck(report({ sources: [brokenBuiltIn] }), builtIns, next)).toMatchObject({
    outcome: "failed",
    subjects: [firstSource.registration.canonicalPath],
  });
});

it("groups quarantined candidates per source into declaration and other problems", () => {
  const issues = [
    ...trouble.catalog.issues,
    resourceIssue("/fx/a-source", "declaration-path-missing"),
    resourceIssue("/fx/a-source", "declaration-name-invalid"),
    resourceIssue("/fx/b-source", "declaration-path-missing"),
    resourceIssue("/fx/b-source", "skill-frontmatter-schema-invalid"),
  ];
  expect(sourcesCheck(report({ catalog: { ...trouble.catalog, issues } }), builtIns, next)).toEqual(
    {
      id: "sources",
      outcome: "warning",
      message:
        "6 catalog candidates quarantined in 3 sources: /fx/a-source (2 declaration problems); /fx/b-source (1 declaration problem, 1 other problem); /fx/source (2 other problems).",
      subjects: ["/fx/a-source", "/fx/b-source", "/fx/source"],
      next: ["tack", "catalog"],
    },
  );
});

it("warns about sources that declare nothing, one or several, and about no source at all", () => {
  const clean = { ...trouble.catalog, issues: [] };
  const declaringNothing = (canonicalPath: string, index: number) =>
    ({
      registration: registration(canonicalPath, index),
      status: "healthy",
      warnings: [{ code: "source-declares-no-resources", message: "Nothing declared." }],
    }) satisfies StatusSource;
  const one = sourcesCheck(
    report({ catalog: clean, sources: [firstSource, declaringNothing("/fx/empty", 1)] }),
    builtIns,
    next,
  );
  expect(one).toMatchObject({ outcome: "warning", subjects: ["/fx/empty"] });
  expect(one.message).toContain("1 registered source declares no resources, so nothing from it");
  expect("next" in one).toBe(false);
  const two = sourcesCheck(
    report({
      catalog: clean,
      sources: [declaringNothing("/fx/z", 1), declaringNothing("/fx/y", 2)],
    }),
    builtIns,
    next,
  );
  expect(two.subjects).toEqual(["/fx/y", "/fx/z"]);
  expect(two.message).toContain("2 registered sources declare no resources, so nothing from them");
  const none = {
    id: "sources",
    outcome: "warning",
    message: "No source is registered. Register a folder of skills with tack source add PATH.",
    next: ["tack", "source", "add", "PATH"],
  };
  expect(sourcesCheck(report({ catalog: clean, sources: [] }), builtIns, next)).toEqual(none);
  // The built-in source ships with Tack: on its own, the operator has registered nothing.
  expect(sourcesCheck(report({ catalog: clean, sources: [firstSource] }), builtIns, next)).toEqual(
    none,
  );
  expect(sourcesCheck(report({ catalog: clean }), builtIns, next)).toEqual({
    id: "sources",
    outcome: "ok",
    message: "1 registered source, all healthy.",
  });
});

it("reports registered dependency sources as ok", () => {
  expect(identityChecks(report({}), next)).toEqual([
    {
      id: "unregistered-dependency-source",
      outcome: "ok",
      message: "All declared dependency sources are registered.",
    },
  ]);
});

it("names an unregistered dependency source, or unknown when the dependency names none", () => {
  const [requester] = firstNamespace.desired;
  if (requester === undefined) throw new Error("The fixture namespace lost its desired resources.");
  const blocked = (source: string | undefined) => ({
    _tag: "required-source-unregistered" as const,
    dependency: {
      kind: "skill" as const,
      name: "helper",
      ...(source === undefined ? {} : { source }),
    },
    requester,
  });
  const namespace: StatusNamespace = {
    ...firstNamespace,
    resolution: {
      ...firstNamespace.resolution,
      groups: [
        ...firstNamespace.resolution.groups,
        {
          _tag: "blocked",
          blockers: [
            blocked("toolbox"),
            blocked(undefined),
            { ...blocked(undefined), _tag: "required-missing" },
          ],
          members: [requester],
        },
      ],
    },
  };
  const [unregistered] = identityChecks(report({ namespaces: [namespace] }), next);
  expect(unregistered).toEqual({
    id: "unregistered-dependency-source",
    outcome: "warning",
    message:
      "Dependency source toolbox is not registered. Run tack source add <path-to-source>, then tack sync.",
    subjects: ["toolbox", "unknown"],
    next: ["tack", "source"],
  });
  const unnamed: StatusNamespace = {
    ...namespace,
    resolution: {
      ...namespace.resolution,
      groups: [{ _tag: "blocked", blockers: [blocked(undefined)], members: [requester] }],
    },
  };
  expect(identityChecks(report({ namespaces: [unnamed] }), next)[0]?.message).toContain(
    "Dependency source unknown is not registered.",
  );
});

it("skips without projects, fails on a damaged one and warns about one being removed", () => {
  expect(projectsCheck(report({ projects: [] }), outside, next)).toEqual({
    id: "projects",
    outcome: "skipped",
    message:
      "No project is registered. Register one with tack project add NAME from inside its repository.",
  });
  const brokenAnchor: StatusProject = {
    ...firstProject,
    name: "zeta",
    anchor: {
      path: "/fx/zeta/.git",
      status: "unhealthy",
      issue: { code: "anchor-missing", message: "gone" },
    },
  };
  const gone = {
    health: "missing",
    issue: { code: "root-missing", message: "gone" },
    lifecycle: "active",
    path: "/fx/alpha",
  } satisfies StatusProject["roots"][number];
  const missingRoot: StatusProject = { ...firstProject, name: "alpha", roots: [gone] };
  // A root that is being removed may be missing without damaging its project.
  const removedRoot: StatusProject = {
    ...firstProject,
    name: "omega",
    roots: [{ ...gone, lifecycle: "removing" }],
  };
  expect(
    projectsCheck(report({ projects: [brokenAnchor, missingRoot, removedRoot] }), outside, next),
  ).toEqual({
    id: "projects",
    outcome: "failed",
    message: "2 projects with a missing or unhealthy anchor or root.",
    subjects: ["alpha", "zeta"],
    next: ["tack", "project", "refresh", "--project", "zeta"],
  });
  const removing: StatusProject = { ...firstProject, name: "leaving", lifecycle: "removing" };
  expect(projectsCheck(report({ projects: [firstProject, removing] }), outside, next)).toEqual({
    id: "projects",
    outcome: "warning",
    message: "1 project being removed.",
    subjects: ["leaving"],
    next: ["tack", "state", "clean", "--pending", "--project", "leaving"],
  });
  expect(projectsCheck(trouble, outside, next)).toEqual({
    id: "projects",
    outcome: "ok",
    message: "1 registered project, all healthy.",
  });
});

it("fails on foreign entries without a repair command, since Tack never moves them", () => {
  const check = linksCheck(
    report({ destinations: [...healthy, destination("foreign-entry", "/fx/zz")] }),
    next,
  );
  expect(check).toEqual({
    id: "links",
    outcome: "failed",
    message: "1 destination differs from what Tack expects; 1 foreign entry left untouched.",
    subjects: ["demo"],
  });
  // The fixture's drifted project links are repaired by syncing their project.
  expect(linksCheck(trouble, next)).toMatchObject({
    outcome: "failed",
    subjects: ["demo"],
    next: ["tack", "sync", "--project", "demo"],
  });
});

it("warns on a hand-made entry Tack never linked and names the exclude that keeps it", () => {
  const handMade = destination("hand-made", "/fx/リポジトリ/.cursor/skills/localized");
  expect(linksCheck(report({ destinations: [...healthy, handMade] }), next)).toEqual({
    id: "links",
    outcome: "warning",
    message:
      "Hand-made demo:.cursor/skills/localized is kept; Tack's localized is not linked there. Exclude Tack's localized from demo to keep yours on purpose, or move yours away and sync.",
    subjects: ["demo"],
    next: [
      "tack",
      "pick",
      "exclude",
      `${sourceId}:localized`,
      "--kind",
      "skill",
      "--project",
      "demo",
    ],
  });
  const userEntry = {
    ...destination("hand-made", "/home/operator/.claude/skills/localized", userTarget),
  };
  expect(linksCheck(report({ destinations: [userEntry, handMade] }), next)).toEqual({
    id: "links",
    outcome: "warning",
    message:
      "2 hand-made entries are kept, so Tack's resources are not linked there: user:.claude/skills/localized (localized), demo:.cursor/skills/localized (localized). Exclude Tack's resource to keep yours on purpose, or move yours away and sync.",
    subjects: ["demo", "user"],
    next: ["tack", "pick", "exclude", `${sourceId}:localized`, "--kind", "skill", "--user"],
  });
});

it("fails when a hand-made entry comes with drift, and names the repair before the exclude", () => {
  const check = linksCheck(
    report({
      destinations: [
        ...trouble.destinations,
        destination("hand-made", "/fx/リポジトリ/.cursor/skills/localized"),
      ],
    }),
    next,
  );
  expect(check).toEqual({
    id: "links",
    outcome: "failed",
    message: "2 destinations differ from what Tack expects; 1 hand-made entry kept.",
    subjects: ["demo"],
    next: ["tack", "sync", "--project", "demo"],
  });
});

it("names the exclude when a foreign entry has no repair, and a path outside its target in full", () => {
  const handMade = destination("hand-made", "/fx/リポジトリ/.cursor/skills/localized");
  expect(
    linksCheck(report({ destinations: [destination("foreign-entry", "/fx/zz"), handMade] }), next),
  ).toEqual({
    id: "links",
    outcome: "failed",
    message:
      "1 destination differs from what Tack expects; 1 foreign entry left untouched; 1 hand-made entry kept.",
    subjects: ["demo"],
    next: [
      "tack",
      "pick",
      "exclude",
      `${sourceId}:localized`,
      "--kind",
      "skill",
      "--project",
      "demo",
    ],
  });
  // Nothing desired names a resource, so there is no exclude to suggest.
  const elsewhere = { ...destination("hand-made", "/elsewhere/localized"), desired: [] };
  expect(linksCheck(report({ destinations: [elsewhere] }), next)).toEqual({
    id: "links",
    outcome: "warning",
    message:
      "Hand-made /elsewhere/localized is kept; Tack's resource is not linked there. Exclude Tack's resource from demo to keep yours on purpose, or move yours away and sync.",
    subjects: ["demo"],
  });
});

it("points user drift at a user sync, built-in skill links included", () => {
  const check = linksCheck(
    report({
      destinations: [
        destination("drift", "/home/operator/.claude/skills/use-tack", userTarget),
        destination("drift", "/home/operator/.claude/skills/writer", userTarget),
        destination("expected-absent", "/fx/zz", firstDestination.target),
      ],
    }),
    next,
  );
  expect(check).toEqual({
    id: "links",
    outcome: "failed",
    message: "3 destinations differ from what Tack expects.",
    subjects: ["demo", "user"],
    next: ["tack", "sync", "--user"],
  });
});

it("asks to settle owed removals for the user or the project that owes them", () => {
  const evidence = firstDestination.evidence;
  if (evidence === undefined) throw new Error("The fixture destination lost its evidence.");
  const userRemoval = {
    cause: "clean" as const,
    evidence: { ...evidence, target: userTarget },
    destinationPath: "/home/operator/.agents/skills/localized",
  };
  expect(
    linksCheck(report({ destinations: healthy, pendingRemovals: [userRemoval] }), next),
  ).toEqual({
    id: "links",
    outcome: "failed",
    message: "1 pending removal.",
    subjects: ["user"],
    next: ["tack", "state", "clean", "--pending", "--user"],
  });
  const docsRemoval = {
    cause: "clean" as const,
    evidence: {
      projectName: "demo",
      root: "/fx/demo",
      resource: { sourceRegistrationId: sourceId, name: "notes" },
      destinationPath: "/fx/demo/.tack/docs/notes",
      sourceDirectoryPath: "/fx/source/notes",
      relativeTarget: "../../../source/notes",
    },
  };
  expect(
    linksCheck(
      report({ destinations: healthy, pendingRemovals: [], docsPendingRemovals: [docsRemoval] }),
      next,
    ),
  ).toEqual({
    id: "links",
    outcome: "failed",
    message: "1 pending removal.",
    subjects: ["demo"],
    next: ["tack", "state", "clean", "--pending", "--project", "demo"],
  });
  const both = linksCheck(
    report({
      destinations: [...healthy, destination("foreign-entry", "/fx/zz")],
      pendingRemovals: [userRemoval],
      docsPendingRemovals: [docsRemoval],
    }),
    next,
  );
  expect(both.message).toBe(
    "1 destination differs from what Tack expects; 1 foreign entry left untouched; 2 pending removals.",
  );
  expect(both.next).toEqual(["tack", "state", "clean", "--pending", "--user"]);
});

it("names the project to register, or the worktree to add, from where doctor runs", () => {
  expect(
    projectsCheck(
      report({ projects: [] }),
      { _tag: "unregistered-repository", root: "/fx/app", suggestedName: "app" },
      next,
    ),
  ).toEqual({
    id: "projects",
    outcome: "warning",
    message:
      "No project is registered. This directory is in the Git repository /fx/app, which no project registers.",
    next: ["tack", "project", "add", "app"],
  });
  // Once a project is registered, another repository here is the operator's choice, not a problem.
  expect(
    projectsCheck(
      report({ projects: [firstProject] }),
      { _tag: "unregistered-repository", root: "/fx/app", suggestedName: "app" },
      next,
    ).outcome,
  ).toBe("ok");
  const removing: StatusProject = { ...firstProject, name: "leaving", lifecycle: "removing" };
  expect(
    projectsCheck(
      report({ projects: [firstProject, removing] }),
      { _tag: "unregistered-worktree", projectName: firstProject.name, root: "/fx/app-wt" },
      next,
    ),
  ).toEqual({
    id: "projects",
    outcome: "warning",
    message: `This directory is in /fx/app-wt, a worktree of project ${firstProject.name} that Tack has not registered yet, so it has no links.`,
    subjects: [firstProject.name],
    next: ["tack", "project", "refresh", "--project", firstProject.name],
  });
});

// Runs last: the tests above record every command a check names, from each branch they cover.
it.effect("names only commands the CLI parses", () =>
  Effect.gen(function* () {
    expect(named.length).toBeGreaterThan(10);
    for (const argv of named) {
      expect(argv[0]).toBe("tack");
      yield* parseInvocation(argv.slice(1)).pipe(Effect.provide(BunServices.layer));
    }
  }),
);
