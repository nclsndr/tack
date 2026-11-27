import { Effect } from "effect";
import { checkPaths } from "../../features/check/check-paths.ts";
import { toJson } from "../envelope/outcomes.ts";
import type { RoutesFor } from "./route.ts";

/** No HOME or state location is resolved for file validation. */
export const checkRoutes: RoutesFor<"check"> = {
  check: {
    needsHome: false,
    stateless: true,
    run: (invocation) =>
      checkPaths(invocation.paths).pipe(
        Effect.map((report) => ({
          classification: report.summary.errors > 0 ? ("domain" as const) : ("success" as const),
          diagnostics: [],
          // The commands each finding's remedy names, such as source add for a folder of skills.
          next: report.findings.flatMap((finding) => finding.next ?? []),
          result: toJson(report),
        })),
      ),
  },
};
