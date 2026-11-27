import { Effect, Path } from "effect";
import type { SourceCheckReport } from "../../domain/sources/source-check.ts";
import { emptyState, type State } from "../../domain/state/state-schema.ts";
import {
  resolveStateDirectory,
  stateAutoInitializes,
  type StateOptions,
} from "../../services/state-store.ts";
import { linkingNext } from "../projects/checkout.ts";
import { readInvocationSnapshot } from "../snapshot/command-snapshot.ts";
import { sourceQualifier } from "../sources/resource-reference.ts";
import { checkSource } from "../sources/source-check.ts";
import {
  planSourceScaffold,
  refuseScaffoldInsideSources,
  scaffoldLoadsNothing,
  type SourceAddRequestError,
  type SourceConfig,
  writeSourceScaffold,
} from "../sources/source-scaffold.ts";
import {
  planSourceRegistration,
  prospectiveSourceLabel,
  registerSource,
  type SourceMutationResult,
  type SourceRegistrationPlanSchema,
} from "../sources/source.ts";

/** The tack.yaml `source add --config` plans for a source without one, with its declaration. */
type ScaffoldPlan = NonNullable<Effect.Success<ReturnType<typeof planSourceScaffold>>>;

/** The state an `--apply` initializes: the default state directory and the agents it enables. */
export type PlannedInitialization = {
  readonly stateDirectory: string;
  readonly enabledAdapters: ReadonlyArray<string>;
};

/**
 * What `source add` did or would do:
 * - `registration-preview`: a source that has its tack.yaml, previewed. `linking` is where its
 *   resources go next, present only when the source is registered already.
 * - `scaffold-preview`: the tack.yaml a config declares, previewed. `loadsNothing` is why it would
 *   never be written.
 * - `registered`: the source registered, after writing the tack.yaml its config declared, if any.
 *
 * A preview's `initialization` is the state its `--apply` would create, absent when it creates none.
 */
type SourceAddition =
  | {
      readonly _tag: "registration-preview";
      readonly plan: typeof SourceRegistrationPlanSchema.Type;
      readonly initialization: PlannedInitialization | undefined;
      readonly linking: ReadonlyArray<string> | undefined;
    }
  | {
      readonly _tag: "scaffold-preview";
      readonly plan: ScaffoldPlan;
      readonly loadsNothing: SourceAddRequestError | undefined;
      readonly initialization: PlannedInitialization | undefined;
    }
  | {
      readonly _tag: "registered";
      readonly source: SourceMutationResult & {
        readonly name: string;
        readonly inspection: SourceCheckReport;
        readonly scaffolded?: string;
      };
      readonly scaffold: ScaffoldPlan | undefined;
      readonly linking: ReadonlyArray<string>;
    };

/** Where newly cataloged resources go next, seen from the current directory. */
const linkingFromHere = Effect.fnUntraced(function* (state: State) {
  return yield* linkingNext(state, (yield* Path.Path).resolve("."));
});

/** The state a preview's `--apply` would initialize, as plain registration does. */
const plannedInitialization = Effect.fnUntraced(function* (stateOptions: StateOptions) {
  const stateDirectory = yield* resolveStateDirectory(stateOptions);
  const enabledAdapters =
    stateOptions.initialAdapters === undefined ? [] : [...(yield* stateOptions.initialAdapters)];
  return { stateDirectory, enabledAdapters } satisfies PlannedInitialization;
});

/**
 * Places a planned declaration among the registered sources: refuses one that a registered source
 * reaches, and names the source by the label it would take beside them.
 */
const placeScaffold = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  scaffold: ScaffoldPlan,
) {
  // Without state no source is registered, so a preview still needs none.
  const inspections = yield* readInvocationSnapshot(stateOptions).pipe(
    Effect.flatMap((snapshot) => snapshot.sourceInspections),
    Effect.map((found) => ({ stateExists: true, found })),
    Effect.catchTag("StateNotInitializedError", () =>
      Effect.succeed({ stateExists: false, found: [] }),
    ),
  );
  yield* refuseScaffoldInsideSources(scaffold.sourcePath, inspections.found);
  const name = prospectiveSourceLabel(inspections.found, {
    canonicalPath: scaffold.sourcePath,
    declaration: scaffold.declaration,
  });
  return {
    plan: name === undefined ? scaffold : { ...scaffold, name },
    stateExists: inspections.stateExists,
  };
});

/**
 * Previews registering a source that has its tack.yaml: the name it would take, whether it is
 * registered already, its check, and the state its `--apply` would initialize. It writes nothing.
 */
const previewRegistration = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  sourcePath: string,
) {
  // Without state no source is registered, so a preview still needs none.
  const known = yield* readInvocationSnapshot(stateOptions).pipe(
    Effect.flatMap((snapshot) =>
      Effect.map(snapshot.sourceInspections, (inspections) => ({
        stateExists: true,
        state: snapshot.state,
        inspections,
      })),
    ),
    Effect.catchTag("StateNotInitializedError", () =>
      Effect.succeed({ stateExists: false, state: emptyState(), inspections: [] }),
    ),
  );
  const { source, existing } = yield* planSourceRegistration(known.state, sourcePath);
  const inspection = yield* checkSource(source.canonicalPath);
  const name =
    existing === undefined
      ? prospectiveSourceLabel(known.inspections, source)
      : sourceQualifier({ sources: known.inspections }, existing.id);
  const initializes = known.stateExists === false && stateAutoInitializes(stateOptions);
  return {
    _tag: "registration-preview",
    plan: {
      kind: "source-registration-plan",
      sourcePath: source.canonicalPath,
      ...(name === undefined ? {} : { name }),
      alreadyRegistered: existing !== undefined,
      inspection,
    },
    initialization: initializes ? yield* plannedInitialization(stateOptions) : undefined,
    // A registered source has nothing to apply: its resources go where the next step links them.
    linking: existing === undefined ? undefined : yield* linkingFromHere(known.state),
  } satisfies SourceAddition;
});

/**
 * Previews registering a source, and registers it with `apply`. A source that has its tack.yaml
 * previews its check; for a folder without one, the preview shows the tack.yaml its config
 * declares, and `apply` writes it before registering. A config that does not validate fails with
 * each of its issues. A tack.yaml that a registered source's declaration reaches is refused before
 * either. A declaration in which every entry has a problem and finds no resource is never written.
 */
export const addSource = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  request: {
    readonly sourcePath: string;
    readonly apply: boolean;
    readonly config: SourceConfig | undefined;
  },
) {
  const scaffold = yield* planSourceScaffold(request.sourcePath, request.config);
  if (scaffold === undefined && request.apply === false)
    return yield* previewRegistration(stateOptions, request.sourcePath);
  const placed = scaffold === undefined ? undefined : yield* placeScaffold(stateOptions, scaffold);
  const plan = placed?.plan;
  // A declaration that would load nothing previews as partial and never applies.
  const loadsNothing = plan === undefined ? undefined : scaffoldLoadsNothing(plan);
  // Applying initializes absent default state, as plain registration does.
  const initializes = placed?.stateExists === false && stateAutoInitializes(stateOptions);
  if (plan !== undefined && request.apply === false)
    return {
      _tag: "scaffold-preview",
      plan,
      loadsNothing,
      initialization:
        loadsNothing === undefined && initializes
          ? yield* plannedInitialization(stateOptions)
          : undefined,
    } satisfies SourceAddition;
  if (loadsNothing !== undefined) return yield* loadsNothing;
  if (plan !== undefined) {
    // State that cannot be read refuses before the tack.yaml is written; absent default state is
    // initialized by the registration.
    if (initializes === false) yield* readInvocationSnapshot(stateOptions);
    yield* writeSourceScaffold(plan);
  }
  const registered = yield* registerSource(stateOptions, { sourcePath: request.sourcePath });
  const inspection = yield* checkSource(registered.registration.canonicalPath);
  const snapshot = yield* readInvocationSnapshot(stateOptions);
  const linking = yield* linkingFromHere(snapshot.state);
  const name = sourceQualifier(
    { sources: yield* snapshot.sourceInspections },
    registered.registration.id,
  );
  return {
    _tag: "registered",
    source: {
      ...registered,
      name,
      inspection,
      ...(plan === undefined ? {} : { scaffolded: plan.declarationPath }),
    },
    scaffold: plan,
    linking,
  } satisfies SourceAddition;
});
