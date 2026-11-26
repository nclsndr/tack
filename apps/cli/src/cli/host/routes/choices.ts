import { requireMutableChoice } from "../../../features/choices/builtin-choice.ts";
import { Effect } from "effect";
import {
  catalogAddressCandidates,
  ChoiceListPayloadSchema,
  ChoiceRemovalPayloadSchema,
  listSkillChoices,
  removeSkillChoice,
  setSkillChoice,
} from "../../../features/choices/choice.ts";
import {
  userLinkedExcludes,
  userLinksOf,
} from "../../../features/reconciliation/linked-for-user.ts";
import { withCommandWriter } from "../../../features/writer/recovered-writer.ts";
import { readInvocationSnapshot } from "../../../features/snapshot/command-snapshot.ts";
import type { StateOptions } from "../../../services/state-store.ts";
import {
  ResourceReferenceError,
  resolveResourceReference,
  sourceQualifier,
} from "../../../features/sources/resource-reference.ts";
import { isSelectableAddress, type Catalog } from "../../../domain/sources/catalog-schema.ts";
import { selectableKinds, type SelectableKind } from "../../../domain/resources/kinds.ts";
import type { ChoiceNamespace, SkillChoice } from "../../../domain/choices/choice-schema.ts";
import { argvLine, commandLine, selectorFlags, shellWord } from "../command-line.ts";
import { appliedAs, choiceSetOutcome, resultAs } from "../outcomes.ts";
import type { RoutesFor } from "./route.ts";

const resolvePick = Effect.fnUntraced(function* (
  catalog: Catalog,
  reference: string,
  command: string,
  namespace: ChoiceNamespace,
  kind?: SelectableKind,
) {
  const entry = yield* resolveResourceReference(
    catalog,
    reference,
    selectableKinds,
    command,
    kind,
    selectorFlags(namespace).map(shellWord),
  );
  if (isSelectableAddress(entry.address)) {
    yield* requireMutableChoice(catalog, entry.address);
    return entry.address;
  }
  // Coverage skip: the reference resolves only pick kinds; this narrows the type for the compiler.
  /* v8 ignore next -- @preserve */
  return yield* new ResourceReferenceError({
    code: "resource-not-found",
    message: `No selectable resource matches ${reference}.`,
    candidates: [],
  });
});

const resolveStoredPick = Effect.fnUntraced(function* (
  catalog: Catalog,
  choices: ReadonlyArray<SkillChoice>,
  namespace: ChoiceNamespace,
  reference: string,
  kind?: SelectableKind,
) {
  const colon = reference.indexOf(":");
  const prefix = colon < 0 ? undefined : reference.slice(0, colon);
  const qualified =
    prefix !== undefined &&
    (catalog.sources?.some((source) => source.label === prefix) === true ||
      choices.some((choice) => choice.address.sourceRegistrationId === prefix));
  const name = qualified ? reference.slice(colon + 1) : reference;
  const matches = choices.filter(
    (choice) =>
      choice.namespace._tag === namespace._tag &&
      (choice.namespace._tag !== "project" ||
        namespace._tag !== "project" ||
        choice.namespace.projectName === namespace.projectName) &&
      choice.address.name === name &&
      (kind === undefined || choice.address.kind === kind) &&
      (!qualified ||
        choice.address.sourceRegistrationId === prefix ||
        sourceQualifier(catalog, choice.address.sourceRegistrationId) === prefix),
  );
  const [only] = matches;
  if (only !== undefined && matches.length === 1) {
    yield* requireMutableChoice(catalog, only.address);
    return only.address;
  }
  // With no saved pick, a built-in reference still reports why it cannot be changed.
  if (matches.length === 0) {
    const entry = yield* resolveResourceReference(
      catalog,
      reference,
      selectableKinds,
      commandLine("choice-remove"),
      kind,
    ).pipe(Effect.catchTag("ResourceReferenceError", () => Effect.succeed(undefined)));
    if (entry !== undefined && isSelectableAddress(entry.address))
      yield* requireMutableChoice(catalog, entry.address);
  }
  // The reference stays unquoted, as `resolveResourceReference` prints its candidates.
  const candidates = matches.map(
    (choice) =>
      `${commandLine("choice-remove")} ${sourceQualifier(catalog, choice.address.sourceRegistrationId)}:${choice.address.name} --kind ${choice.address.kind} ${argvLine(selectorFlags(namespace))}`,
  );
  return yield* new ResourceReferenceError({
    code: matches.length === 0 ? "resource-not-found" : "resource-ambiguous",
    message:
      matches.length === 0
        ? `No stored pick matches ${reference}. Run ${commandLine("pick-list")} to list picks.`
        : `${reference} matches several picks. Use ${candidates.join(" or ")}.`,
    candidates,
  });
});

/** Sets one pick after resolving its reference, from the document the writer holds. */
const setPick = (
  stateOptions: StateOptions,
  request: {
    readonly command: string;
    readonly decision: "include" | "exclude";
    readonly kind?: SelectableKind;
    readonly namespace: ChoiceNamespace;
    readonly reference: string;
  },
) =>
  withCommandWriter(stateOptions, (writer, snapshot) =>
    Effect.gen(function* () {
      yield* listSkillChoices(snapshot.state, request.namespace);
      const catalog = yield* snapshot.catalog;
      const address = yield* resolvePick(
        catalog,
        request.reference,
        request.command,
        request.namespace,
        request.kind,
      );
      const applied = yield* setSkillChoice(writer, {
        address,
        decision: request.decision,
        namespace: request.namespace,
      });
      return choiceSetOutcome(
        applied,
        catalogAddressCandidates(catalog, applied.choice.address),
        userLinkedExcludes(userLinksOf(snapshot.state, catalog, false), [applied.choice]),
      );
    }),
  );

/** Persisted include and exclude choices. */
export const choiceRoutes: RoutesFor<
  "choice-remove" | "choice-set" | "choice-exclude" | "pick-list"
> = {
  "choice-set": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      setPick(stateOptions, {
        command: commandLine("choice-set"),
        decision: "include",
        namespace: invocation.namespace,
        reference: invocation.reference,
        ...(invocation.kind === undefined ? {} : { kind: invocation.kind }),
      }),
  },
  "choice-exclude": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      setPick(stateOptions, {
        command: commandLine("choice-exclude"),
        decision: "exclude",
        namespace: invocation.namespace,
        reference: invocation.reference,
        ...(invocation.kind === undefined ? {} : { kind: invocation.kind }),
      }),
  },
  "choice-remove": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      withCommandWriter(stateOptions, (writer, snapshot) =>
        Effect.gen(function* () {
          const catalog = yield* snapshot.catalog;
          const choices = yield* listSkillChoices(snapshot.state, invocation.namespace);
          const address = yield* resolveStoredPick(
            catalog,
            choices,
            invocation.namespace,
            invocation.reference,
            invocation.kind,
          );
          return appliedAs(ChoiceRemovalPayloadSchema)(
            yield* removeSkillChoice(writer, { address, namespace: invocation.namespace }),
          );
        }),
      ),
  },
  "pick-list": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      Effect.gen(function* () {
        const { state } = yield* readInvocationSnapshot(stateOptions);
        const choices = yield* listSkillChoices(state, invocation.namespace);
        return resultAs(ChoiceListPayloadSchema)({ choices });
      }),
  },
};
