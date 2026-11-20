import { Effect } from "effect";
import type { DoctorCheck } from "../../domain/doctor/doctor-schema.ts";
import { profileDefinitionFindings } from "../profiles/profile-check.ts";
import type { CommandSnapshot } from "../snapshot/command-snapshot.ts";

/** Flags malformed/unresolved source publications independently of applied profile inventories. */
export const profileDefinitionsCheck = Effect.fnUntraced(function* (snapshot: CommandSnapshot) {
  const sources = yield* snapshot.sourceInspections;
  const findings = yield* profileDefinitionFindings(sources, yield* snapshot.catalog);
  const errors = findings.filter((finding) => finding.severity === "error");
  const sourcePaths = sources.flatMap((source) =>
    source.status === "healthy" && source.origin !== "builtin"
      ? [source.registration.canonicalPath]
      : [],
  );
  return {
    id: "profile-definitions",
    outcome: errors.length > 0 ? "failed" : findings.length > 0 ? "warning" : "ok",
    message:
      findings.length === 0
        ? "Published profile definitions are valid and linked."
        : findings
            .map((finding) => `${finding.file}: ${finding.code}: ${finding.message}`)
            .join(" "),
    ...(findings.length === 0
      ? {}
      : {
          subjects: [...new Set(findings.map((finding) => finding.file))],
          next: ["tack", "check", ...sourcePaths],
        }),
  } satisfies DoctorCheck;
});
