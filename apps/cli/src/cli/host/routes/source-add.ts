import { Effect, Schema } from "effect";
import type { SourceFinding } from "../../../domain/sources/source-check.ts";
import { emptyState } from "../../../domain/state/state-schema.ts";
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
  planSourceRegistration,
  prospectiveSourceLabel,
  registerSource,
  SourceRegistrationPayloadSchema,
  SourceRegistrationPlanSchema,
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

/** Each error a source's check finds, as a diagnostic naming its file. */
const findingProblems = (findings: ReadonlyArray<SourceFinding>) =>
  findings.flatMap((finding) =>
    finding.severity === "error"
      ? [
          {
            code: finding.code,
            message: finding.message,
            severity: "error" as const,
            // The file always, and the field when the finding names one.
            details: Object.fromEntries(
              Object.entries({ file: finding.file, field: finding.field }).filter(
                (detail): detail is [string, string] => detail[1] !== undefined,
              ),
            ),
          },
        ]
      : [],
  );

/** Each error an entry of a planned declaration finds, as a diagnostic naming its file. */
const scaffoldProblems = (plan: Parameters<typeof scaffoldPlanJson>[0]) =>
  findingProblems(plan.entries.flatMap((entry) => entry.findings));

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

const encodeRegistrationPlan = Schema.encodeSync(SourceRegistrationPlanSchema);

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
  const problems = findingProblems(inspection.findings);
  const initializes = known.stateExists === false && stateAutoInitializes(stateOptions);
  return {
    classification: problems.length === 0 ? ("success" as const) : ("partial" as const),
    diagnostics: [
      ...problems,
      ...(initializes ? [yield* plannedInitialization(stateOptions)] : []),
    ],
    // A registered source has nothing to apply: its resources go where the next step links them.
    next:
      existing === undefined
        ? [["tack", "source", "add", source.canonicalPath, "--apply"]]
        : [yield* linkingNext(known.state, yield* cwdOrCurrent(undefined))],
    plan: toJson(
      encodeRegistrationPlan({
        kind: "source-registration-plan",
        sourcePath: source.canonicalPath,
        ...(name === undefined ? {} : { name }),
        alreadyRegistered: existing !== undefined,
        inspection,
      }),
    ),
  };
});

/**
 * Previews registering a source, and registers it with --apply. A source that has its tack.yaml
 * previews its check; for a folder without one, the preview shows the tack.yaml its kind flags
 * declare, and --apply writes it before registering. A tack.yaml that a registered source's
 * declaration reaches is refused before either. A declaration in which every entry has a problem
 * and finds no resource is never written.
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
  if (scaffold === undefined && invocation.apply !== true)
    return yield* previewRegistration(stateOptions, invocation.sourcePath);
  const placed = scaffold === undefined ? undefined : yield* placeScaffold(stateOptions, scaffold);
  const plan = placed?.plan;
  // A declaration that would load nothing previews as partial, without --apply, and never applies.
  const refusal = plan === undefined ? undefined : scaffoldLoadsNothing(plan);
  // Applying initializes absent default state, as plain registration does.
  const initializes = placed?.stateExists === false && stateAutoInitializes(stateOptions);
  if (plan !== undefined && invocation.apply !== true) {
    // A resource the declaration finds but cannot read is a problem of the preview, not a success.
    const problems = scaffoldProblems(plan);
    return refusal === undefined
      ? {
          classification: problems.length === 0 ? ("success" as const) : ("partial" as const),
          diagnostics: [
            ...problems,
            ...(initializes ? [yield* plannedInitialization(stateOptions)] : []),
          ],
          next: [applyCommand(plan)],
          plan: toJson(scaffoldPlanJson(plan)),
        }
      : {
          classification: "partial" as const,
          diagnostics: [
            ...problems,
            { code: refusal.code, message: refusal.message, severity: "warning" as const },
          ],
          next: [],
          plan: toJson(scaffoldPlanJson(plan)),
        };
  }
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
