import { Effect } from "effect";
import {
  applyImport,
  previewImport,
  type ImportRequest,
} from "../../../features/imports/import.ts";
import { inspectImports } from "../../../features/imports/import-inspect.ts";
import type { ImportPlan } from "../../../domain/imports/import-schema.ts";
import { planImportRemoval, removeImport } from "../../../features/imports/import-removal.ts";
import { readInvocationSnapshot } from "../../../features/snapshot/command-snapshot.ts";
import { resultOutcome, toJson } from "../outcomes.ts";
import type { PublicOutcome } from "../public-outcome.ts";
import type { RoutesFor } from "./route.ts";

const planDiagnostics = (plan: ImportPlan): PublicOutcome["diagnostics"] => [
  ...(plan.outcome === "needs-selection"
    ? [
        {
          code: "import-selection-required",
          message:
            "Several skills can be imported. Choose with --skill NAME (repeatable) or --all.",
          severity: "info" as const,
        },
      ]
    : []),
  ...(plan.outcome === "needs-destination" || plan.destination === undefined
    ? [
        {
          code: "import-destination-required",
          message: "--apply needs --into SOURCE[:FOLDER], the source that receives the skills.",
          severity: "info" as const,
        },
      ]
    : []),
  ...(plan.outcome === "refused" && plan.refusal !== undefined
    ? [
        {
          code: plan.refusal.code,
          message: plan.refusal.message,
          severity: "warning" as const,
        },
      ]
    : []),
  ...(plan.outcome === "nothing-importable"
    ? [
        {
          code: "import-nothing-importable",
          message:
            "Nothing in this location can be imported. Scope it to a folder, or search deeper with --full-depth.",
          severity: "info" as const,
        },
      ]
    : []),
];

const requestOf = (invocation: {
  readonly location: string;
  readonly into?: string;
  readonly skills: ReadonlyArray<string>;
  readonly all: boolean;
  readonly fullDepth: boolean;
}): ImportRequest => ({
  location: invocation.location,
  ...(invocation.into === undefined ? {} : { into: invocation.into }),
  skills: invocation.skills,
  all: invocation.all,
  fullDepth: invocation.fullDepth,
});

/** The `import` group: list, add and remove. Only `import add` uses the network. */
export const importRoutes: RoutesFor<"import-add" | "import-list" | "import-remove"> = {
  "import-list": {
    needsHome: false,
    run: (_, stateOptions) =>
      readInvocationSnapshot(stateOptions).pipe(
        Effect.flatMap(({ state }) => inspectImports(state)),
        Effect.map(resultOutcome),
      ),
  },
  "import-add": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      invocation.apply
        ? applyImport(stateOptions, requestOf(invocation)).pipe(
            Effect.map(({ plan, applied }): PublicOutcome => ({
              classification: "success",
              diagnostics: [],
              plan: toJson(plan),
              applied: toJson(applied),
            })),
          )
        : previewImport(stateOptions, requestOf(invocation)).pipe(
            Effect.map((plan): PublicOutcome => ({
              classification: "success",
              diagnostics: planDiagnostics(plan),
              plan: toJson(plan),
            })),
          ),
  },
  "import-remove": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      invocation.apply
        ? removeImport(stateOptions, invocation.reference, invocation.force).pipe(
            Effect.map(({ plan, applied }): PublicOutcome => ({
              classification: "success",
              diagnostics: [],
              // Absent when the apply only finished an earlier interrupted removal of this skill.
              ...(plan === undefined ? {} : { plan: toJson(plan) }),
              applied: toJson(applied),
            })),
          )
        : planImportRemoval(stateOptions, invocation.reference, invocation.force).pipe(
            Effect.map((plan): PublicOutcome => ({
              classification: "success",
              diagnostics: [],
              plan: toJson(plan),
            })),
          ),
  },
};
