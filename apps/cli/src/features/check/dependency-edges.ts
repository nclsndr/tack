import { Effect, FileSystem, Match } from "effect";
import type { CheckFinding } from "../../domain/check/check-schema.ts";
import type { UnresolvedDependencyEdge } from "../../domain/choices/dependency-resolution.ts";
import { catalogEntryPath } from "../../domain/sources/catalog-schema.ts";
import { dependencyLine } from "./finding-location.ts";

const unique = (names: ReadonlyArray<string>) => [...new Set(names)];
const and = (names: ReadonlyArray<string>) => new Intl.ListFormat("en").format(unique(names));
const or = (names: ReadonlyArray<string>) =>
  new Intl.ListFormat("en", { type: "disjunction" }).format(unique(names));

/** The finding code of each reason a dependency edge names no single resource. */
const findingCodes = {
  missing: "dependency-missing",
  quarantined: "dependency-quarantined",
  "source-undeclared": "dependency-source-undeclared",
  "source-unregistered": "dependency-source-unchecked",
  "source-unhealthy": "dependency-source-unhealthy",
  ambiguous: "dependency-ambiguous",
} as const satisfies Record<UnresolvedDependencyEdge["failure"]["reason"], string>;

/**
 * Why the edge fails and how to fix it, worded for a check that reads only its paths. `own` is the
 * label of the requester's source.
 */
const explanation = (
  { dependency, failure }: UnresolvedDependencyEdge,
  own: string,
): { readonly why: string; readonly remedy: string } =>
  Match.value(failure).pipe(
    Match.when({ reason: "missing" }, () =>
      dependency.source === undefined
        ? {
            why: `which neither ${own} nor a source it declares provides`,
            remedy:
              "Correct the name, declare the source that provides it in depends-on, or remove the dependency.",
          }
        : {
            why: `which ${dependency.source} does not provide`,
            remedy: "Correct the name or the source of the dependency.",
          },
    ),
    Match.when({ reason: "quarantined" }, ({ source }) => ({
      why: `which is quarantined in ${source}`,
      remedy: `Run tack check on the folder of ${source} to see why, then fix it.`,
    })),
    Match.when({ reason: "source-undeclared" }, ({ providers }) =>
      dependency.source === undefined
        ? {
            why: `which only a source that ${own} does not declare provides: ${and(providers)}`,
            remedy: `Add ${or(providers)} to depends-on in the tack.yaml of ${own}.`,
          }
        : {
            why: `from ${dependency.source}, which ${own} does not declare`,
            remedy: `Add ${dependency.source} to depends-on in the tack.yaml of ${own}.`,
          },
    ),
    Match.when({ reason: "source-unregistered" }, ({ labels }) => ({
      why:
        dependency.source === undefined
          ? `which neither ${own} nor a checked source it declares provides, while ${own} also declares ${and(labels)}, not among the checked paths`
          : `from ${dependency.source}, which is not among the checked paths`,
      remedy: `Pass the folder of ${and(labels)} to the same tack check to verify the dependency.`,
    })),
    Match.when({ reason: "source-unhealthy" }, ({ labels, unhealthySources }) => ({
      why:
        dependency.source === undefined
          ? `which neither ${own} nor a checked source it declares provides, while ${and(labels)} may be a source Tack cannot read`
          : `from ${dependency.source}, which may be a source Tack cannot read`,
      remedy: `Fix the findings of ${and(unhealthySources)}, or pass the folder of ${and(labels)} to the same tack check.`,
    })),
    Match.when({ reason: "ambiguous" }, ({ providers }) => {
      const shared = unique(providers.filter((name, index) => providers.indexOf(name) !== index));
      return shared.length > 0
        ? {
            why: `which several sources named ${and(shared)} provide`,
            remedy: `Give each source named ${and(shared)} its own name in its tack.yaml.`,
          }
        : {
            why: `which several sources provide: ${and(providers)}`,
            remedy: `Name one in the dependency, as ${or(providers.map((name) => `source: ${name}`))}.`,
          };
    }),
    Match.exhaustive,
  );

/**
 * Whether an edge is broken whatever else is registered. A required edge that cannot resolve
 * blocks its requester at sync, so it is an error; an optional one is skipped, so it is a warning.
 * An edge to a source the check cannot read is a warning: the check cannot say it is broken.
 */
const severityOf = ({ dependency, failure }: UnresolvedDependencyEdge): CheckFinding["severity"] =>
  dependency.optional === true ||
  failure.reason === "source-unregistered" ||
  failure.reason === "source-unhealthy"
    ? "warning"
    : "error";

/**
 * One finding per edge of one source, anchored at the line of the edge in the requester's file.
 * `own` names that source in the messages.
 */
export const dependencyEdgeFindings = Effect.fnUntraced(function* (
  edges: ReadonlyArray<UnresolvedDependencyEdge>,
  own: string,
): Effect.fn.Return<ReadonlyArray<CheckFinding>, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.forEach(edges, (edge) =>
    Effect.gen(function* () {
      const { dependency, requester } = edge;
      const file = catalogEntryPath(requester);
      const text = yield* fs.readFileString(file).pipe(
        // Coverage skip: the catalog has just read this file, so only a race can fail the read.
        /* v8 ignore next -- @preserve */
        Effect.orElseSucceed(() => ""),
      );
      const { why, remedy } = explanation(edge, own);
      const target = `${dependency.kind} ${dependency.source === undefined ? "" : `${dependency.source}:`}${dependency.name}${dependency.optional === true ? " (optional)" : ""}`;
      return {
        code: findingCodes[edge.failure.reason],
        severity: severityOf(edge),
        file,
        line: dependencyLine(text, edge.position),
        message: `${requester.address.kind} ${requester.address.name} needs ${target}, ${why}.`,
        remedy,
      };
    }),
  );
});
