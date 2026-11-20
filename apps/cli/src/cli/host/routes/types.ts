import { Effect } from "effect";
import {
  TypesTargetError,
  typesStubName,
  writeTypes,
  type TypesPlan,
} from "../../../features/execution/script-types.ts";
import { tackVersion } from "../../../version.ts";
import { toJson } from "../outcomes.ts";
import type { RoutesFor } from "./route.ts";

/** A warning when the source's own `tsconfig.json` may leave the stub out of the editor's project. */
const scopeDiagnostics = (plan: TypesPlan) =>
  plan.inScope === true
    ? []
    : [
        {
          code: "types-stub-out-of-scope",
          severity: "warning" as const,
          message:
            plan.inScope === false
              ? `tsconfig.json does not include ${typesStubName}. Add "${typesStubName}" to its "include" list, or the editor will not know the "@tackup/cli" import.`
              : `Tack could not read tsconfig.json. Check that it includes ${typesStubName}, or the editor will not know the "@tackup/cli" import.`,
          details: { path: plan.files[1]?.path ?? null },
        },
      ];

/** Editor types for a source's scripts. */
export const typesRoutes: RoutesFor<"types"> = {
  types: {
    needsHome: false,
    stateless: true,
    run: ({ path, apply }) =>
      writeTypes(path ?? ".", tackVersion, apply).pipe(
        Effect.map((plan) => {
          const diagnostics = scopeDiagnostics(plan);
          return {
            classification: diagnostics.length === 0 ? ("success" as const) : ("partial" as const),
            diagnostics,
            plan: toJson(plan),
            ...(apply ? { applied: toJson(plan) } : {}),
          };
        }),
        Effect.catchTag("TypesTargetError", (error: TypesTargetError) =>
          Effect.succeed({
            classification: "invalid-configuration" as const,
            diagnostics: [
              {
                code: "types-not-a-source",
                severity: "error" as const,
                message: `${error.directory} has no tack.yaml. Run tack types in a source folder, or pass its path.`,
                details: { directory: error.directory },
              },
            ],
          }),
        ),
      ),
  },
};
