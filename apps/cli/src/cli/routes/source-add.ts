import { Effect, Match, Schema, Stdio, Stream } from "effect";
import type { SourceFinding } from "../../domain/sources/source-check.ts";
import { addSource, type PlannedInitialization } from "../../features/registration/source-add.ts";
import {
  scaffoldPlanJson,
  SourceAddRequestError,
  type SourceConfig,
  type SourceConfigInvalidError,
} from "../../features/sources/source-scaffold.ts";
import { SourceRegistrationPlanSchema } from "../../features/sources/source.ts";
import type { StateOptions } from "../../services/state-store.ts";
import { appliedAs, toJson } from "../envelope/outcomes.ts";
import type { PublicOutcome } from "../envelope/public-outcome.ts";

/** Diagnostic details without the ones a finding or an issue leaves out. */
const definedDetails = (details: Readonly<Record<string, string | number | undefined>>) =>
  Object.fromEntries(
    Object.entries(details).filter(
      (detail): detail is [string, string | number] => detail[1] !== undefined,
    ),
  );

/** Each error a source's check finds, as a diagnostic naming its file. */
const findingProblems = (findings: ReadonlyArray<SourceFinding>) =>
  findings.flatMap((finding) =>
    finding.severity === "error"
      ? [
          {
            code: finding.code,
            message: finding.message,
            severity: "error" as const,
            // The file always, and the field and its line when the finding names them.
            details: definedDetails({
              file: finding.file,
              field: finding.field,
              line: finding.line,
            }),
          },
        ]
      : [],
  );

/**
 * Each error a planned declaration finds, on the declaration as a whole or under one of its
 * entries, as a diagnostic naming its file.
 */
const scaffoldProblems = (plan: Parameters<typeof scaffoldPlanJson>[0]) =>
  findingProblems([...plan.findings, ...plan.entries.flatMap((entry) => entry.findings)]);

/**
 * A config that does not validate: one diagnostic per issue, each with the field and the line in
 * the config it concerns, so every issue can be fixed before the next preview.
 */
const invalidConfig = (error: SourceConfigInvalidError): PublicOutcome => ({
  classification: "invalid-configuration",
  diagnostics: error.issues.map((issue) => ({
    code: error.code,
    message: issue.message,
    severity: "error",
    details: definedDetails({ config: error.config, field: issue.field, line: issue.line }),
  })),
  next: [["tack", "guide", "tack-yaml"]],
});

/**
 * The JSON `source add --config` takes: the flag's value itself, or standard input for `-`. Standard
 * input that cannot be read is refused with `config-unreadable`. A value is never read as a path.
 */
const readConfig = Effect.fnUntraced(function* (config: string) {
  if (config !== "-") return { text: config, origin: "argument" } satisfies SourceConfig;
  const stdio = yield* Stdio.Stdio;
  const text = yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.mapError(
      (cause) =>
        new SourceAddRequestError({
          code: "config-unreadable",
          message: `Tack could not read the --config declaration from standard input: ${cause.message}`,
        }),
    ),
  );
  return { text, origin: "standard-input" } satisfies SourceConfig;
});

/**
 * What a preview tells about the state its `--apply` initializes, as plain registration would: the
 * default state directory and the agents found in the home. Nothing when the state exists.
 */
const initializationNotice = (initialization: PlannedInitialization | undefined) => {
  if (initialization === undefined) return [];
  const { stateDirectory, enabledAdapters } = initialization;
  const enables =
    enabledAdapters.length === 0
      ? "; no agent folder was found in this home, so no agent is enabled"
      : ` and enables the agents found in this home: ${enabledAdapters.join(", ")}`;
  return [
    {
      code: "state-initialization-planned",
      severity: "info" as const,
      message: `Tack state does not exist yet: --apply initializes it at ${stateDirectory}${enables}.`,
      details: { stateDirectory, enabledAdapters },
    },
  ];
};

const encodeRegistrationPlan = Schema.encodeSync(SourceRegistrationPlanSchema);

/**
 * Previews registering a source, and registers it with --apply, as `addSource` does. A config that
 * does not validate reports each of its issues.
 */
export const sourceAddOutcome = Effect.fnUntraced(
  function* (
    stateOptions: StateOptions,
    invocation: {
      readonly sourcePath: string;
      readonly apply?: boolean;
      readonly config?: string;
    },
  ) {
    const config =
      invocation.config === undefined ? undefined : yield* readConfig(invocation.config);
    const addition = yield* addSource(stateOptions, {
      sourcePath: invocation.sourcePath,
      apply: invocation.apply === true,
      config,
    });
    return Match.valueTags(addition, {
      "registration-preview": ({ plan, initialization, linking }) => {
        const problems = findingProblems(plan.inspection.findings);
        return {
          classification: problems.length === 0 ? ("success" as const) : ("partial" as const),
          diagnostics: [...problems, ...initializationNotice(initialization)],
          next:
            linking === undefined
              ? [["tack", "source", "add", plan.sourcePath, "--apply"]]
              : [linking],
          plan: toJson(encodeRegistrationPlan(plan)),
        };
      },
      // The JSON is not echoed back: the view says to run the same command with --apply.
      "scaffold-preview": ({ plan, loadsNothing, initialization }) => {
        // A resource the declaration finds but cannot read is a problem of the preview, not a success.
        const problems = scaffoldProblems(plan);
        return loadsNothing === undefined
          ? {
              classification: problems.length === 0 ? ("success" as const) : ("partial" as const),
              diagnostics: [...problems, ...initializationNotice(initialization)],
              next: [],
              plan: toJson(scaffoldPlanJson(plan)),
            }
          : {
              classification: "partial" as const,
              diagnostics: [
                ...problems,
                {
                  code: loadsNothing.code,
                  message: loadsNothing.message,
                  severity: "warning" as const,
                },
              ],
              next: [],
              plan: toJson(scaffoldPlanJson(plan)),
            };
      },
      registered: ({ source, scaffold, linking }) => ({
        // Problems the check found come first; then where the new resources go.
        next: [
          ...(source.inspection.findings.length === 0
            ? []
            : [["tack", "check", source.registration.canonicalPath]]),
          linking,
        ],
        ...appliedAs("source-add")(source),
        ...(scaffold === undefined ? {} : { plan: toJson(scaffoldPlanJson(scaffold)) }),
      }),
    });
  },
  Effect.catchTag("SourceConfigInvalidError", (error) => Effect.succeed(invalidConfig(error))),
);
