import { sourceQualifier } from "../sources/resource-reference.ts";
import { Effect } from "effect";
import { inspectDocs } from "../docs/docs.ts";
import type { ImportsDisplay } from "../imports/import-display.ts";
import { allDocsSettings } from "../../domain/state/state-intent.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import type { StatusDestination, StatusReport } from "../../domain/status/status-schema.ts";
import { destinationPlace } from "../../domain/status/destination-place.ts";
import type { StateOptions } from "../../services/state-store.ts";
import { readInvocationSnapshot } from "../snapshot/command-snapshot.ts";
import type { DoctorCheck } from "../../domain/doctor/doctor-schema.ts";
import type { CheckoutObservation } from "../projects/checkout.ts";

/** Builds the argv of a suggested command, carrying the operator's state directory. */
type NextCommand = (argv: ReadonlyArray<string>) => ReadonlyArray<string>;

const sorted = (values: Iterable<string>) => [...new Set(values)].sort(compareCodeUnits);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A check that could not observe its area. */
export const skippedCheck = (id: DoctorCheck["id"], message: string): DoctorCheck => ({
  id,
  outcome: "skipped",
  message,
});

const targetSelectorOf = (destination: StatusDestination): ReadonlyArray<string> =>
  destination.target._tag === "user" ? ["--user"] : ["--project", destination.target.projectName];

const targetNameOf = (destination: StatusDestination) =>
  destination.target._tag === "user" ? "user" : destination.target.projectName;

/** The enabled adapters, and any destination an adapter could not be observed at. */
export const adaptersCheck = (status: StatusReport, next: NextCommand): DoctorCheck => {
  if (status.enabledAdapters.length === 0)
    return {
      id: "adapters",
      outcome: "warning",
      message:
        "No agent adapter is enabled, so nothing is delivered. tack init enables the agents it finds in your home.",
      next: next(["tack", "init"]),
    };
  const unobserved = status.destinations.filter(
    (destination) => destination._tag === "observation-failed",
  );
  return unobserved.length === 0
    ? {
        id: "adapters",
        outcome: "ok",
        message: `Enabled: ${status.enabledAdapters.join(", ")}.`,
        subjects: [...status.enabledAdapters],
      }
    : {
        id: "adapters",
        outcome: "failed",
        message: `${plural(unobserved.length, "adapter destination")} could not be observed.`,
        subjects: sorted(unobserved.map(({ destinationPath }) => destinationPath)),
      };
};

/**
 * Registered source health, and candidates the catalog quarantined. Only the sources the operator
 * registered count: a healthy built-in source ships with Tack and is no registration of theirs,
 * while a broken one still fails the check.
 *
 * @param builtIns - The registration IDs of the built-in sources.
 */
export const sourcesCheck = (
  status: StatusReport,
  builtIns: ReadonlySet<string>,
  next: NextCommand,
): DoctorCheck => {
  const sources = status.sources.filter(
    (source) => source.status === "unhealthy" || builtIns.has(source.registration.id) === false,
  );
  const unhealthy = sources.filter((source) => source.status === "unhealthy");
  const quarantined = status.catalog.issues.filter((issue) => issue.subject._tag === "resource");
  const undeclared = unhealthy.flatMap((source) =>
    source.status === "unhealthy" && source.issue.code === "declaration-resources-undeclared"
      ? [source.issue.message]
      : [],
  );
  if (unhealthy.length > 0)
    return {
      id: "sources",
      outcome: "failed",
      message: `${plural(unhealthy.length, "registered source")} of ${sources.length} unhealthy; inspect them, then relocate or remove what moved.${undeclared.length === 0 ? "" : ` ${undeclared.join(" ")}`}`,
      subjects: sorted(unhealthy.map(({ registration }) => registration.canonicalPath)),
      next: next(["tack", "source"]),
    };
  if (quarantined.length > 0) {
    const bySource = Map.groupBy(quarantined, (issue) => issue.subject.sourcePath);
    const perSource = [...bySource]
      .toSorted(([left], [right]) => compareCodeUnits(left, right))
      .map(([sourcePath, issues]) => {
        const declaration = issues.filter((issue) => issue.code.startsWith("declaration-")).length;
        const other = issues.length - declaration;
        return `${sourcePath} (${[
          ...(declaration === 0 ? [] : [plural(declaration, "declaration problem")]),
          ...(other === 0 ? [] : [plural(other, "other problem")]),
        ].join(", ")})`;
      });
    return {
      id: "sources",
      outcome: "warning",
      message: `${plural(quarantined.length, "catalog candidate")} quarantined in ${plural(bySource.size, "source")}: ${perSource.join("; ")}.`,
      subjects: sorted(bySource.keys()),
      next: next(["tack", "catalog"]),
    };
  }
  const declaringNothing = sources.flatMap((source) =>
    source.status === "healthy" && (source.warnings ?? []).length > 0 ? [source] : [],
  );
  if (declaringNothing.length > 0)
    return {
      id: "sources",
      outcome: "warning",
      message: `${plural(declaringNothing.length, "registered source")} declare${declaringNothing.length === 1 ? "s" : ""} no resources, so nothing from ${declaringNothing.length === 1 ? "it" : "them"} is cataloged. Use the manage-tack-sources skill, or add skills, commands, context, scripts or docs entries to the tack.yaml.`,
      subjects: sorted(declaringNothing.map(({ registration }) => registration.canonicalPath)),
    };
  return sources.length === 0
    ? {
        id: "sources",
        outcome: "warning",
        message: "No source is registered. Register a folder of skills with tack source add PATH.",
        next: next(["tack", "source", "add", "PATH"]),
      }
    : {
        id: "sources",
        outcome: "ok",
        message: `${plural(sources.length, "registered source")}, all healthy.`,
      };
};

/** Declared dependencies on sources that are not registered. */
export const identityChecks = (
  status: StatusReport,
  next: NextCommand,
): ReadonlyArray<DoctorCheck> => {
  const unregistered = status.namespaces.flatMap((namespace) =>
    namespace.resolution.groups.flatMap((group) =>
      group._tag === "blocked"
        ? group.blockers.filter((blocker) => blocker._tag === "required-source-unregistered")
        : [],
    ),
  );
  const firstUnregistered = unregistered[0];
  return [
    unregistered.length === 0
      ? {
          id: "unregistered-dependency-source",
          outcome: "ok",
          message: "All declared dependency sources are registered.",
        }
      : {
          id: "unregistered-dependency-source",
          outcome: "warning",
          message: `Dependency source ${firstUnregistered?.dependency.source ?? "unknown"} is not registered. Run tack source add <path-to-source>, then tack sync.`,
          subjects: unregistered.map((blocker) => blocker.dependency.source ?? "unknown"),
          next: next(["tack", "source"]),
        },
  ];
};

/**
 * Project anchors and roots, projects whose removal is still in progress, and where doctor runs:
 * with no project registered, a repository there is the one to register; a worktree of a
 * registered project that refresh has not added has no links, whatever the other roots show.
 */
export const projectsCheck = (
  status: StatusReport,
  checkout: CheckoutObservation,
  next: NextCommand,
): DoctorCheck => {
  if (status.projects.length === 0)
    return checkout._tag === "unregistered-repository"
      ? {
          id: "projects",
          outcome: "warning",
          message: `No project is registered. This directory is in the Git repository ${checkout.root}, which no project registers.`,
          next: next(["tack", "project", "add", checkout.suggestedName]),
        }
      : skippedCheck(
          "projects",
          "No project is registered. Register one with tack project add NAME from inside its repository.",
        );
  const damaged = status.projects.filter(
    (project) =>
      project.anchor.status === "unhealthy" ||
      project.roots.some((root) => root.lifecycle === "active" && root.health !== "healthy"),
  );
  const first = damaged[0];
  if (first !== undefined)
    return {
      id: "projects",
      outcome: "failed",
      message: `${plural(damaged.length, "project")} with a missing or unhealthy anchor or root.`,
      subjects: sorted(damaged.map(({ name }) => name)),
      next: next(["tack", "project", "refresh", "--project", first.name]),
    };
  if (checkout._tag === "unregistered-worktree")
    return {
      id: "projects",
      outcome: "warning",
      message: `This directory is in ${checkout.root}, a worktree of project ${checkout.projectName} that Tack has not registered yet, so it has no links.`,
      subjects: [checkout.projectName],
      next: next(["tack", "project", "refresh", "--project", checkout.projectName]),
    };
  const removing = status.projects.filter((project) => project.lifecycle === "removing");
  const firstRemoving = removing[0];
  return firstRemoving === undefined
    ? {
        id: "projects",
        outcome: "ok",
        message: `${plural(status.projects.length, "registered project")}, all healthy.`,
      }
    : {
        id: "projects",
        outcome: "warning",
        message: `${plural(removing.length, "project")} being removed.`,
        subjects: sorted(removing.map(({ name }) => name)),
        next: next(["tack", "state", "clean", "--pending", "--project", firstRemoving.name]),
      };
};

/**
 * The exclude that keeps a hand-made entry on purpose: Tack's resource is deselected for the
 * namespace that selected it, so no adapter links it there any more.
 */
const keepHandMade = (status: StatusReport, destination: StatusDestination) => {
  const address = destination.desired[0]?.address;
  return address === undefined
    ? undefined
    : [
        "tack",
        "pick",
        "exclude",
        `${sourceQualifier(status, address.sourceRegistrationId)}:${address.name}`,
        "--kind",
        address.kind,
        ...targetSelectorOf(destination),
      ];
};

/** Says which hand-made entries Tack keeps, and that its own resources are not linked there. */
const handMadeMessage = (handMade: ReadonlyArray<StatusDestination>) => {
  const placeOf = (destination: StatusDestination) =>
    destinationPlace(destination) ?? destination.destinationPath;
  const nameOf = (destination: StatusDestination) =>
    destination.desired[0]?.address.name ?? "resource";
  const [only] = handMade;
  return only !== undefined && handMade.length === 1
    ? `Hand-made ${placeOf(only)} is kept; Tack's ${nameOf(only)} is not linked there. Exclude Tack's ${nameOf(only)} from ${targetNameOf(only)} to keep yours on purpose, or move yours away and sync.`
    : `${handMade.length} hand-made entries are kept, so Tack's resources are not linked there: ${handMade
        .map((destination) => `${placeOf(destination)} (${nameOf(destination)})`)
        .join(
          ", ",
        )}. Exclude Tack's resource to keep yours on purpose, or move yours away and sync.`;
};

/**
 * Managed-link drift, foreign entries and pending removals across every target fail the check. A
 * hand-made entry that was in the way before Tack linked anything only warns: Tack keeps it and
 * links everything else, and the operator decides whether to keep it or move it.
 */
export const linksCheck = (status: StatusReport, next: NextCommand): DoctorCheck => {
  const unhealthy = status.destinations.filter(
    (destination) =>
      destination._tag !== "matching" &&
      destination._tag !== "observation-failed" &&
      destination._tag !== "hand-made",
  );
  const handMade = status.destinations.filter((destination) => destination._tag === "hand-made");
  // A docs mount that owes its removal is an owed removal like an agent link's.
  const pending = [
    ...status.pendingRemovals.map(({ evidence: { target } }) => target),
    ...(status.docsPendingRemovals ?? []).map(
      ({ evidence }) =>
        ({
          _tag: "project-root",
          canonicalPath: evidence.root,
          projectName: evidence.projectName,
        }) as const,
    ),
  ];
  if (unhealthy.length === 0 && pending.length === 0 && handMade.length === 0)
    return {
      id: "links",
      outcome: "ok",
      message: `${plural(status.destinations.length, "managed destination")}, all matching.`,
    };
  const handMadeSubjects = handMade.map(targetNameOf);
  const keep = handMade[0] === undefined ? undefined : keepHandMade(status, handMade[0]);
  if (unhealthy.length === 0 && pending.length === 0)
    return {
      id: "links",
      outcome: "warning",
      message: handMadeMessage(handMade),
      subjects: sorted(handMadeSubjects),
      ...(keep === undefined ? {} : { next: next(keep) }),
    };
  const fixable = unhealthy.find((destination) => destination._tag !== "foreign-entry");
  const settle = pending[0];
  const foreign = unhealthy.filter((destination) => destination._tag === "foreign-entry");
  const parts = [
    ...(unhealthy.length === 0
      ? []
      : [
          `${plural(unhealthy.length, "destination")} ${unhealthy.length === 1 ? "differs" : "differ"} from what Tack expects`,
        ]),
    ...(foreign.length === 0 ? [] : [`${plural(foreign.length, "foreign entry")} left untouched`]),
    ...(pending.length === 0 ? [] : [plural(pending.length, "pending removal")]),
    ...(handMade.length === 0
      ? []
      : [`${handMade.length} hand-made ${handMade.length === 1 ? "entry" : "entries"} kept`]),
  ];
  const repair =
    fixable !== undefined
      ? ["tack", "sync", ...targetSelectorOf(fixable)]
      : settle !== undefined
        ? [
            "tack",
            "state",
            "clean",
            "--pending",
            ...(settle._tag === "user" ? ["--user"] : ["--project", settle.projectName]),
          ]
        : keep;
  return {
    id: "links",
    outcome: "failed",
    message: `${parts.join("; ")}.`,
    subjects: sorted([
      ...unhealthy.map(targetNameOf),
      ...handMadeSubjects,
      ...pending.map((target) => (target._tag === "user" ? "user" : target.projectName)),
    ]),
    ...(repair === undefined ? {} : { next: next(repair) }),
  };
};

/**
 * Attached docs per project: resources or documents that fail to load and conflicting mounts fail
 * the check; mounts still to create or settle only warn. A project whose root cannot be used is
 * left to the `projects` check. Any other failure to observe a project's docs fails the check with
 * its cause: an observation that did not happen is never reported as healthy.
 */
export const docsCheck = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  status: StatusReport,
  next: NextCommand,
) {
  const { state } = yield* readInvocationSnapshot(stateOptions);
  const attached = allDocsSettings(state).filter(
    (settings) =>
      settings.attachments.length > 0 &&
      status.projects.some((project) => project.name === settings.projectName),
  );
  if (attached.length === 0)
    return skippedCheck("docs", "No docs resource is attached to a project.");
  const findings = yield* Effect.forEach(attached, ({ projectName }) =>
    inspectDocs(stateOptions, { projectName }).pipe(
      Effect.map((docs) => ({
        projectName,
        unloadable: docs.issues.length > 0,
        conflict: docs.mounts.some((mount) => mount.state === "conflict"),
        pending: docs.mounts.some((mount) => mount.state !== "mounted"),
      })),
      Effect.map((finding) => ({ ...finding, failure: undefined as string | undefined })),
      Effect.catch((error) =>
        Effect.succeed({
          projectName,
          unloadable: false,
          conflict: false,
          pending: false,
          // Only the root-ineligible case belongs to the `projects` check; anything else did not
          // observe the docs, so it cannot be a pass.
          failure:
            error._tag === "DocsError" && error.code === "docs-project-unavailable"
              ? undefined
              : error.message,
        }),
      ),
    ),
  );
  const unobserved = findings.filter(({ failure }) => failure !== undefined);
  const [firstUnobserved] = unobserved;
  if (firstUnobserved !== undefined)
    return {
      id: "docs",
      outcome: "failed",
      message: `${plural(unobserved.length, "project")} whose docs could not be observed: ${firstUnobserved.failure}`,
      subjects: sorted(unobserved.map(({ projectName }) => projectName)),
      next: next(["tack", "docs", "--project", firstUnobserved.projectName]),
    } satisfies DoctorCheck;
  const problems = findings
    .filter(({ unloadable, pending }) => unloadable || pending)
    .map((finding) => ({ ...finding, failing: finding.unloadable || finding.conflict }));
  const first = problems.find(({ failing }) => failing) ?? problems[0];
  if (first === undefined)
    return {
      id: "docs",
      outcome: "ok",
      message: `${plural(attached.length, "project")} with attached docs, all mounted and loading.`,
    } satisfies DoctorCheck;
  return {
    id: "docs",
    outcome: first.failing ? "failed" : "warning",
    message: first.failing
      ? `${plural(problems.length, "project")} with a docs resource or document that fails to load, or a conflicting mount.`
      : `${plural(problems.length, "project")} with an attached docs resource that is not mounted.`,
    subjects: sorted(problems.map(({ projectName }) => projectName)),
    // Mounts are repaired by reconciling; a document or resource that fails to load is inspected.
    next: next(
      first.unloadable && !first.conflict && !first.pending
        ? ["tack", "docs", "--project", first.projectName]
        : ["tack", "sync", "--project", first.projectName],
    ),
  } satisfies DoctorCheck;
});

/** What probing `git` found: its version, or why imports cannot fetch. */
export type GitProbe =
  | { readonly available: true; readonly version: string }
  | { readonly available: false; readonly message: string };

/**
 * The skills a source imported, and whether `import add` can fetch. An imports section that does
 * not decode, an imported folder that is gone or that no skills entry covers, and a staging folder
 * left by an interrupted write fail the check. A locally changed folder is information, and a
 * missing or too old `git` is a warning, because nothing delivered depends on it.
 */
export const importsCheck = (
  display: ImportsDisplay,
  git: GitProbe,
  next: NextCommand,
): DoctorCheck => {
  const changed = display.imports.filter(({ local }) => local.state === "changed");
  const missing = display.imports.filter(({ local }) => local.state === "missing");
  const uncataloged = display.imports.filter(({ conditions }) =>
    conditions.some(({ code }) => code === "import-folder-not-cataloged"),
  );
  const invalid = display.problems.filter(({ code }) => code === "imports-invalid");
  const staging = display.problems.filter(({ code }) => code === "staging-left-over");
  const [firstMissing] = missing;
  const [firstUncataloged] = uncataloged;
  const info =
    changed.length === 0
      ? ""
      : ` ${plural(changed.length, "imported skill")} ${changed.length === 1 ? "has" : "have"} local changes, which is allowed: ${sorted(changed.map(({ reference }) => reference)).join(", ")}.`;
  const findings = [
    ...invalid.map(({ message }) => message),
    ...missing.map(({ conditions }) => conditions[0]?.message ?? ""),
    ...uncataloged.flatMap(({ conditions }) =>
      conditions
        .filter(({ code }) => code === "import-folder-not-cataloged")
        .map(({ message }) => message),
    ),
    ...staging.map(({ message }) => message),
  ];
  if (findings.length > 0)
    return {
      id: "imports",
      outcome: "failed",
      message: `${findings.join(" ")}${info}`,
      subjects: sorted([
        ...invalid.map(({ source }) => source),
        ...missing.map(({ reference }) => reference),
        ...uncataloged.map(({ reference }) => reference),
        ...staging.map(({ source }) => source),
      ]),
      next:
        invalid.length === 0 && firstMissing !== undefined
          ? next(["tack", "import", "remove", firstMissing.reference])
          : invalid.length === 0 && firstUncataloged !== undefined
            ? next(["tack", "catalog"])
            : next(["tack", "import"]),
    };
  if (!git.available)
    return {
      id: "imports",
      outcome: "warning",
      message: `${git.message} \`tack import add\` needs git to fetch.${info}`,
    };
  return {
    id: "imports",
    outcome: "ok",
    message:
      display.imports.length === 0
        ? `No skill is imported. git ${git.version} can fetch for \`tack import add\`.`
        : `${plural(display.imports.length, "imported skill")}, all present and cataloged. git ${git.version} can fetch.${info}`,
    ...(changed.length === 0
      ? {}
      : { subjects: sorted(changed.map(({ reference }) => reference)) }),
  };
};
