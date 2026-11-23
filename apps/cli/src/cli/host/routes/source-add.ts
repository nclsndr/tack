import { Effect, Path } from "effect";
import { checkSource } from "../../../features/sources/source-check.ts";
import {
  applyCommand,
  planSourceScaffold,
  refuseScaffoldInsideSources,
  scaffoldLoadsNothing,
  scaffoldPlanJson,
  writeSourceScaffold,
} from "../../../features/sources/source-scaffold.ts";
import type { SourceFolders } from "../../../domain/sources/source-folders.ts";
import {
  prospectiveSourceLabel,
  registerSource,
  SourceRegistrationPayloadSchema,
} from "../../../features/sources/source.ts";
import { sourceQualifier } from "../../../features/sources/resource-reference.ts";
import {
  resolveStateDirectory,
  stateAutoInitializes,
  type StateOptions,
} from "../../../services/state-store.ts";
import { readInvocationSnapshot } from "../../../features/snapshot/command-snapshot.ts";
import { appliedAs, toJson } from "../outcomes.ts";
import { linkingNext } from "../../../features/projects/checkout.ts";
import { cwdOrCurrent } from "./route.ts";

/**
 * Places a planned declaration among the registered sources: refuses one that a registered source
 * reaches, and names the source by the label it would take beside them.
 */
const placeScaffold = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  scaffold: NonNullable<Effect.Success<ReturnType<typeof planSourceScaffold>>>,
) {
  const path = yield* Path.Path;
  // Without state no source is registered, so a preview still needs none.
  const inspections = yield* readInvocationSnapshot(stateOptions).pipe(
    Effect.flatMap((snapshot) => snapshot.sourceInspections),
    Effect.map((found) => ({ stateExists: true, found })),
    Effect.catchTag("StateNotInitializedError", () =>
      Effect.succeed({ stateExists: false, found: [] }),
    ),
  );
  yield* refuseScaffoldInsideSources(scaffold.sourcePath, inspections.found);
  const name = prospectiveSourceLabel(
    inspections.found,
    { canonicalPath: scaffold.sourcePath, declaration: scaffold.declaration },
    (sourcePath) => path.basename(sourcePath),
  );
  return {
    plan: name === undefined ? scaffold : { ...scaffold, name },
    stateExists: inspections.stateExists,
  };
});

/**
 * What a preview tells about the state its `--apply` initializes, as plain registration would: the
 * default state directory and the agents found in the home. A preview writes neither.
 */
const plannedInitialization = Effect.fnUntraced(function* (stateOptions: StateOptions) {
  const stateDirectory = yield* resolveStateDirectory(stateOptions);
  const enabledAdapters =
    stateOptions.initialAdapters === undefined ? [] : [...(yield* stateOptions.initialAdapters)];
  const enables =
    enabledAdapters.length === 0
      ? "; no agent folder was found in this home, so no agent is enabled"
      : ` and enables the agents found in this home: ${enabledAdapters.join(", ")}`;
  return {
    code: "state-initialization-planned",
    severity: "info" as const,
    message: `Tack state does not exist yet: --apply initializes it at ${stateDirectory}${enables}.`,
    details: { stateDirectory, enabledAdapters },
  };
});

/**
 * Registers a source that has its tack.yaml at once. For a folder without one, previews the
 * tack.yaml its kind flags declare, and writes it and registers the source with --apply. A
 * tack.yaml that a registered source's declaration reaches is refused before either. A
 * declaration in which every entry has a problem and finds no resource is never written.
 */
export const addSource = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  invocation: {
    readonly sourcePath: string;
    readonly apply?: boolean;
    readonly folders: SourceFolders;
  },
) {
  const scaffold = yield* planSourceScaffold(invocation.sourcePath, invocation.folders);
  const placed = scaffold === undefined ? undefined : yield* placeScaffold(stateOptions, scaffold);
  const plan = placed?.plan;
  // A declaration that would load nothing previews as partial, without --apply, and never applies.
  const refusal = plan === undefined ? undefined : scaffoldLoadsNothing(plan);
  // Applying initializes absent default state, as plain registration does.
  const initializes = placed?.stateExists === false && stateAutoInitializes(stateOptions);
  if (plan !== undefined && invocation.apply !== true)
    return refusal === undefined
      ? {
          classification: "success" as const,
          diagnostics: initializes ? [yield* plannedInitialization(stateOptions)] : [],
          next: [applyCommand(plan)],
          plan: toJson(scaffoldPlanJson(plan)),
        }
      : {
          classification: "partial" as const,
          diagnostics: [
            { code: refusal.code, message: refusal.message, severity: "warning" as const },
          ],
          next: [],
          plan: toJson(scaffoldPlanJson(plan)),
        };
  if (refusal !== undefined) return yield* refusal;
  if (plan !== undefined) {
    // State that cannot be read refuses before the tack.yaml is written; absent default state is
    // initialized by the registration.
    if (initializes === false) yield* readInvocationSnapshot(stateOptions);
    yield* writeSourceScaffold(plan);
  }
  const registered = yield* registerSource(stateOptions, invocation);
  const inspection = yield* checkSource(registered.registration.canonicalPath);
  const snapshot = yield* readInvocationSnapshot(stateOptions);
  const next = yield* linkingNext(snapshot.state, yield* cwdOrCurrent(undefined));
  const name = sourceQualifier(
    { sources: yield* snapshot.sourceInspections },
    registered.registration.id,
  );
  return {
    // Problems the check found come first; then where the new resources go.
    next: [
      ...(inspection.findings.length === 0
        ? []
        : [["tack", "check", registered.registration.canonicalPath]]),
      next,
    ],
    ...appliedAs(SourceRegistrationPayloadSchema)({
      ...registered,
      name,
      inspection,
      ...(plan === undefined ? {} : { scaffolded: plan.declarationPath }),
    }),
    ...(plan === undefined ? {} : { plan: toJson(scaffoldPlanJson(plan)) }),
  };
});
