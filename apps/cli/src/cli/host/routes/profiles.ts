import { readBundleArchive } from "../../../features/profiles/bundle-read.ts";
import { runBundleExport } from "../../../features/profiles/bundle-export.ts";
import { runBundleApply } from "../../../features/profiles/bundle-apply.ts";
import {
  runProfileAdopt,
  runProfileSaveSelection,
} from "../../../features/profiles/profile-copy.ts";
import { readInvocationSnapshot } from "../../../features/snapshot/command-snapshot.ts";
import { selectTargets } from "../../../features/projects/project.ts";
import { runProfileApply } from "../../../features/profiles/profile-apply.ts";
import { cwdOrCurrent } from "./route.ts";
import { Effect } from "effect";
import { profileApplyOutcome, resultAs, toJson } from "../outcomes.ts";
import type { RoutesFor } from "./route.ts";

/** Read-only profile validation through the fixed-inventory resolver. */
export const profileRoutes: RoutesFor<
  | "profile-apply"
  | "profile-save"
  | "profile-adopt"
  | "profile-export"
  | "profile-inspect-bundle"
  | "profile-apply-bundle"
> = {
  "profile-export": {
    needsHome: false,
    run: (invocation, options) =>
      runBundleExport(options, invocation).pipe(
        Effect.map((result) => ({
          classification: result.plan.refused ? ("domain" as const) : ("success" as const),
          diagnostics: [],
          plan: toJson(result.plan),
          ...(result.exported
            ? { applied: toJson({ exported: true, output: result.plan.output }) }
            : {}),
        })),
      ),
  },
  "profile-inspect-bundle": {
    needsHome: false,
    stateless: true,
    run: (invocation) =>
      readBundleArchive(invocation.file).pipe(
        Effect.map(({ manifest }) =>
          resultAs("profile-inspect-bundle")({ file: invocation.file, manifest }),
        ),
      ),
  },
  "profile-apply-bundle": {
    needsHome: (invocation) => invocation.namespace["_tag"] === "user",
    run: (invocation, options) =>
      Effect.gen(function* () {
        return yield* runBundleApply(options, {
          ...invocation,
          cwd: yield* cwdOrCurrent(undefined),
        });
      }).pipe(Effect.map(profileApplyOutcome)),
  },
  "profile-save": {
    needsHome: false,
    run: (invocation, options) =>
      Effect.gen(function* () {
        let projectName = invocation.projectName;
        if (invocation.input !== "user" && projectName === undefined) {
          const snapshot = yield* readInvocationSnapshot(options);
          const selection = yield* selectTargets(snapshot.state, options, {
            cwd: yield* cwdOrCurrent(undefined),
            selector: { _tag: "bare" },
          });
          projectName = selection.containingRoot?.projectName;
        }
        const result = yield* runProfileSaveSelection(options, {
          ...invocation,
          input: {
            user: invocation.input !== "project",
            ...(invocation.input === "user" || projectName === undefined ? {} : { projectName }),
          },
        });
        return {
          classification:
            result.plan.findings.length > 0 ? ("domain" as const) : ("success" as const),
          diagnostics: [],
          plan: toJson(result.plan),
          ...(result.saved ? { applied: toJson({ saved: true }) } : {}),
        };
      }),
  },
  "profile-adopt": {
    needsHome: (invocation) => invocation.namespace["_tag"] === "user",
    run: (invocation, options) =>
      Effect.gen(function* () {
        const result = yield* runProfileAdopt(options, {
          ...invocation,
          cwd: yield* cwdOrCurrent(undefined),
        });
        return {
          classification:
            result.plan.findings.length > 0
              ? ("domain" as const)
              : result.plan.blockers.length > 0
                ? ("partial" as const)
                : ("success" as const),
          diagnostics: [],
          plan: toJson(result.plan),
          ...(result.adopted ? { applied: toJson({ adopted: true }) } : {}),
        };
      }),
  },
  "profile-apply": {
    needsHome: (invocation) => invocation.namespace["_tag"] === "user",
    run: (invocation, options) =>
      Effect.gen(function* () {
        const { targetHome, ...request } = invocation;
        return yield* runProfileApply(options, {
          ...request,
          cwd: yield* cwdOrCurrent(undefined),
          ...(targetHome === undefined ? {} : { targetHome }),
        });
      }).pipe(Effect.map(profileApplyOutcome)),
  },
};
