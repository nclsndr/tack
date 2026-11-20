import { Match, Option, Schema } from "effect";
import type { ChoiceNamespace } from "../../../domain/choices/choice-schema.ts";
import type { RequiredDependencyBlocker } from "../../../domain/choices/dependency-resolution.ts";
import { DependencyBlockedSubjectSchema } from "../../../features/reconciliation/partial-cause.ts";
import { commandLine, selectorFlags } from "../command-line.ts";
import type { Style } from "./style.ts";

const decodeSubject = Schema.decodeUnknownOption(DependencyBlockedSubjectSchema);

const referenceOf = (dependency: RequiredDependencyBlocker["dependency"]) =>
  `${dependency.source === undefined ? "" : `${dependency.source}:`}${dependency.name}`;

/** What stops one requirement and the step that lifts it. */
const sentence = (
  blocker: RequiredDependencyBlocker,
  namespace: ChoiceNamespace,
  style: Style,
): string => {
  const { dependency, requester } = blocker;
  const requesterSource = style.source(requester.sourceRegistrationId);
  const lift = Match.value(blocker).pipe(
    Match.tag(
      "required-missing",
      () =>
        "which no registered source provides. Register a source that provides it, or remove the dependency.",
    ),
    Match.tag(
      "required-quarantined",
      () => `which is quarantined. Run ${commandLine("catalog")} to see why, then fix it.`,
    ),
    Match.tag(
      "required-excluded",
      () =>
        `which is excluded. Run ${commandLine("choice-set", referenceOf(dependency), "--kind", dependency.kind, ...selectorFlags(namespace))}.`,
    ),
    Match.tag(
      "required-source-undeclared",
      () =>
        `from a source that ${requesterSource} does not declare. Add ${dependency.source ?? "that source"} to depends-on in the tack.yaml of ${requesterSource}.`,
    ),
    Match.tag(
      "required-source-unregistered",
      () => "from a source that is not registered. Run tack source add with its path.",
    ),
    Match.tag("required-source-unhealthy", ({ unhealthySources }) =>
      unhealthySources.length === 1
        ? `from a source Tack cannot read. A registered source is unhealthy, so its label is unknown. Run ${commandLine("check", unhealthySources[0])} to see what to fix in it.`
        : `from a source Tack cannot read. Registered sources are unhealthy, so their labels are unknown. Run ${unhealthySources.map((path) => commandLine("check", path)).join(" and ")} to see what to fix in them.`,
    ),
    Match.tag(
      "required-ambiguous",
      () =>
        "which several resources match. Name the source in the dependency, as source: <label>, in the requester's tack.yaml.",
    ),
    Match.exhaustive,
  );
  return `${style.reference(requester)} needs ${dependency.kind} ${referenceOf(dependency)}, ${lift}`;
};

/**
 * Why a `dependency-blocked` diagnostic blocks its resources and how to lift it, one sentence per
 * blocker. A subject that does not carry blockers has none.
 */
export const dependencyBlockerSentences = (subject: unknown, style: Style): ReadonlyArray<string> =>
  Option.match(decodeSubject(subject), {
    onNone: () => [],
    onSome: ({ blockers, namespace }) =>
      blockers.map((blocker) => sentence(blocker, namespace, style)),
  });
