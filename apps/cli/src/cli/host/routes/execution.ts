import { Effect, Schema } from "effect";
import {
  clearScriptHistory,
  describeScript,
  listScriptHistory,
  runOperatorScript,
  showScriptHistory,
} from "../../../features/execution/execution.ts";
import { RunResultSchema } from "../../../domain/execution/execution-schema.ts";
import { ExecutionError } from "../../../services/execution-platform.ts";
import {
  readInvocationSnapshot,
  resolveInvocationCatalog,
} from "../../../features/snapshot/command-snapshot.ts";
import {
  ResourceReferenceError,
  resolveResourceReference,
} from "../../../features/sources/resource-reference.ts";
import { commandLine, selectorFlags, shellWord } from "../command-line.ts";
import { notRegistered } from "../errors.ts";
import {
  historyListOutcome,
  previewOutcome,
  resultAs,
  resultOutcome,
  scriptRunOutcome,
} from "../outcomes.ts";
import type { RoutesFor } from "./route.ts";

/** The target flags a run was asked for, quoted, so that a suggested command keeps them. */
const scriptTargetFlags = (request: {
  readonly selector: { readonly _tag: string; readonly projectName?: string };
  readonly root?: string;
  readonly cwd?: string;
}): ReadonlyArray<string> =>
  [
    ...selectorFlags(request.selector),
    ...(request.root === undefined ? [] : ["--root", request.root]),
    ...(request.cwd === undefined ? [] : ["--cwd", request.cwd]),
  ].map(shellWord);

/** Supervised runs and retained run history. */
export const executionRoutes: RoutesFor<
  | "script-history-clear"
  | "script-history-list"
  | "script-history-show"
  | "script-run"
  | "script-show"
> = {
  "script-show": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      Effect.gen(function* () {
        const catalog = yield* resolveInvocationCatalog(stateOptions);
        const entry = yield* resolveResourceReference(
          catalog,
          invocation.reference,
          ["script"],
          commandLine("script-show"),
        );
        // Coverage skip: the reference resolves only scripts; this narrows the type for the compiler.
        /* v8 ignore next -- @preserve */
        if (entry.address.kind !== "script")
          return yield* new ResourceReferenceError({
            code: "resource-not-found",
            message: `No script matches ${invocation.reference}.`,
            candidates: [],
          });
        return yield* describeScript(stateOptions, entry.address);
      }).pipe(Effect.map(resultAs("script-show"))),
  },
  "script-run": {
    // A run may target the user, and its supervisor owns signals until history settles.
    needsHome: true,
    ownsInterruption: true,
    run: (invocation, stateOptions) =>
      Effect.gen(function* () {
        const selector = invocation.request.selector;
        if (selector._tag === "project") {
          const { state } = yield* readInvocationSnapshot(stateOptions);
          if (!state.data.projects.some((project) => project.name === selector.projectName))
            return yield* new ExecutionError({
              stage: "resolution",
              code: "run_project_not_registered",
              message: notRegistered(selector.projectName),
              classification: "invalid-configuration",
              details: { projectName: selector.projectName },
            });
        }
        const catalog = yield* resolveInvocationCatalog(stateOptions);
        const entry = yield* resolveResourceReference(
          catalog,
          invocation.reference,
          ["script"],
          commandLine("script-run"),
          undefined,
          scriptTargetFlags(invocation.request),
        );
        // Coverage skip: the reference resolves only scripts; this narrows the type for the compiler.
        /* v8 ignore next -- @preserve */
        if (entry.address.kind !== "script")
          return yield* new ResourceReferenceError({
            code: "resource-not-found",
            message: `No script matches ${invocation.reference}.`,
            candidates: [],
          });
        return yield* runOperatorScript(stateOptions, {
          ...invocation.request,
          address: entry.address,
        });
      }).pipe(
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(RunResultSchema)(result).pipe(
            Effect.mapError(
              () =>
                new ExecutionError({
                  stage: "worker",
                  code: "run_result_invalid",
                  message: "The execution host returned an invalid run result.",
                  classification: "internal",
                }),
            ),
          ),
        ),
        Effect.map(scriptRunOutcome),
      ),
  },
  "script-history-list": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      listScriptHistory(stateOptions, { limit: invocation.limit, offset: invocation.offset }).pipe(
        Effect.map(historyListOutcome),
      ),
  },
  "script-history-show": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      showScriptHistory(stateOptions, invocation.runId).pipe(Effect.map(resultOutcome)),
  },
  "script-history-clear": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      clearScriptHistory(stateOptions, invocation.apply).pipe(Effect.map(previewOutcome)),
  },
};
