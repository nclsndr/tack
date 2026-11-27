import { profileDefinitionsCheck } from "./profile-definitions.ts";
import { skipNote } from "../../domain/profiles/profile-delivery.ts";
import { Effect, Path } from "effect";
import { listScriptHistory } from "../execution/execution.ts";
import { runStatus } from "../status/status.ts";
import { currentVersionReport } from "../../version.ts";
import { stateFormat } from "../../domain/state/state-format.ts";
import { inspectStateFormat } from "./state-format-probe.ts";
import { ImportRemote } from "../../services/import-remote.ts";
import { resolveStateDirectory, type StateOptions } from "../../services/state-store.ts";
import { readInvocationSnapshot } from "../snapshot/command-snapshot.ts";
import { observeImportsDisplay } from "../imports/import-display.ts";
import { observeCheckout } from "../projects/checkout.ts";
import {
  adaptersCheck,
  docsCheck,
  identityChecks,
  importsCheck,
  type GitProbe,
  linksCheck,
  projectsCheck,
  skippedCheck,
  sourcesCheck,
} from "./doctor-observations.ts";
import type { DoctorCheck, DoctorReport } from "../../domain/doctor/doctor-schema.ts";

/** Carries `--state-dir` into a suggested command when the operator chose the state directory. */
const withStateDirectory = (stateOptions: StateOptions, argv: ReadonlyArray<string>) => {
  const explicit = stateOptions.stateDirectory;
  return explicit === undefined ? argv : [...argv, "--state-dir", explicit];
};

/** The running version. Tack never upgrades itself, so there is no update state to report. */
const releaseCheck = (): DoctorCheck => ({
  id: "release",
  outcome: "ok",
  message: `Tack ${currentVersionReport().stamp} is running; tack upgrade names the command that upgrades it.`,
});

/** The imports check: the imports of every source, offline, and whether `git` can fetch. */
const importsObservation = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  next: (argv: ReadonlyArray<string>) => ReadonlyArray<string>,
) {
  const snapshot = yield* readInvocationSnapshot(stateOptions);
  const display = yield* observeImportsDisplay(
    yield* snapshot.sourceInspections,
    yield* snapshot.catalog,
  );
  const remote = yield* ImportRemote;
  const git = yield* remote.probe.pipe(
    Effect.map((probed): GitProbe => ({ available: true, version: probed.version })),
    Effect.catch((error) => Effect.succeed<GitProbe>({ available: false, message: error.message })),
  );
  return importsCheck(display, git, next);
});

type StateProbe = {
  readonly stateDirectory: string;
  /** Whether the state can be read, so the checks that depend on it can run. */
  readonly readable: boolean;
  readonly check: DoctorCheck;
};

const probe = (stateDirectory: string, readable: boolean, check: DoctorCheck): StateProbe => ({
  stateDirectory,
  readable,
  check,
});

/** The state check, and whether the state is readable so dependent checks can run. */
const stateCheck = Effect.fnUntraced(function* (stateOptions: StateOptions) {
  const stateDirectory = yield* resolveStateDirectory(stateOptions);
  const statePath = (yield* Path.Path).join(stateDirectory, "state.json");
  const found = yield* inspectStateFormat(statePath);
  if (!found.exists)
    return probe(stateDirectory, false, {
      id: "state",
      outcome: "warning",
      message: `No Tack state exists at ${stateDirectory}. tack init sets up this machine: the state, your agents and the built-in skills.`,
      next: withStateDirectory(stateOptions, ["tack", "init"]),
    });
  if (found.format !== null && found.format > stateFormat)
    return probe(stateDirectory, false, {
      id: "state",
      outcome: "failed",
      message: `State format ${found.format} at ${statePath} was written by a newer Tack; this release reads format ${stateFormat}.`,
      next: ["tack", "upgrade"],
    });
  // A corrupt or unreadable document fails here: the report cannot be trusted, so it is not partial.
  yield* readInvocationSnapshot(stateOptions);
  const history = yield* listScriptHistory(stateOptions, { limit: 1 });
  return probe(
    stateDirectory,
    true,
    history.issues.length === 0
      ? {
          id: "state",
          outcome: "ok",
          message: `State format ${found.format ?? "unknown"} at ${stateDirectory} is readable.`,
        }
      : {
          id: "state",
          outcome: "warning",
          message: `${history.issues.length} retained script run record${history.issues.length === 1 ? "" : "s"} could not be read.`,
          subjects: history.issues.map(({ path }) => path),
          next: withStateDirectory(stateOptions, ["tack", "script", "history"]),
        },
  );
});

/**
 * Reads the machine's health without changing it: the release, the state, and, when the state is
 * readable, everything the status, source, project and docs observations report. It never
 * initializes state, prompts, fetches or repairs; each problem names the command that addresses it.
 */
export const runDoctor = Effect.fn("doctor.runDoctor")(function* (
  stateOptions: StateOptions,
  home: string,
) {
  const version = currentVersionReport();
  const release = releaseCheck();
  const state = yield* stateCheck(stateOptions);
  const nextWith = (argv: ReadonlyArray<string>) => withStateDirectory(stateOptions, argv);
  const unreadable = `Not observed: ${state.check.id === "state" && state.check.outcome === "failed" ? "this release cannot read the state." : "there is no state to read."}`;
  const rest: ReadonlyArray<DoctorCheck> = state.readable
    ? yield* Effect.gen(function* () {
        const cwd = (yield* Path.Path).resolve(".");
        const status = yield* runStatus(stateOptions, {
          cwd,
          selector: { _tag: "all" },
          userTarget: home,
        });
        const snapshot = yield* readInvocationSnapshot(stateOptions);
        const profiles = status.namespaces.flatMap((entry) =>
          entry.profile === undefined
            ? []
            : [...entry.profile.issues, ...entry.profile.delivery.issues],
        );
        // A member an enabled agent cannot take is a note, not a failure.
        const skipped = [
          ...new Set(
            status.namespaces.flatMap((entry) =>
              (entry.profile?.delivery.skipped ?? []).map(skipNote),
            ),
          ),
        ];
        return [
          {
            id: "profiles" as const,
            outcome: profiles.length === 0 ? ("ok" as const) : ("failed" as const),
            message:
              profiles.length > 0
                ? profiles.join(" ")
                : skipped.length === 0
                  ? "Retained profile inventories are resolved."
                  : `Retained profile inventories are resolved. Skipped where an agent cannot take them: ${skipped.join("; ")}.`,
          },
          yield* profileDefinitionsCheck(snapshot),
          adaptersCheck(status, nextWith),
          sourcesCheck(
            status,
            new Set(
              (yield* snapshot.sourceInspections).flatMap(({ origin, registration }) =>
                origin === "builtin" ? [registration.id] : [],
              ),
            ),
            nextWith,
          ),
          yield* importsObservation(stateOptions, nextWith),
          ...identityChecks(status, nextWith),
          projectsCheck(status, yield* observeCheckout(snapshot.state, cwd), nextWith),
          linksCheck(status, nextWith),
          yield* docsCheck(stateOptions, status, nextWith),
        ];
      })
    : [
        skippedCheck("adapters", unreadable),
        skippedCheck("sources", unreadable),
        skippedCheck("imports", unreadable),
        skippedCheck("profiles", unreadable),
        skippedCheck("profile-definitions", unreadable),
        skippedCheck("unregistered-dependency-source", unreadable),
        skippedCheck("projects", unreadable),
        skippedCheck("links", unreadable),
        skippedCheck("docs", unreadable),
      ];
  const checks = [release, state.check, ...rest];
  const count = (outcome: DoctorCheck["outcome"]) =>
    checks.filter((check) => check.outcome === outcome).length;
  return {
    kind: "doctor-report",
    release: { stamp: version.stamp, sourceRun: version.sourceRun },
    stateDirectory: state.stateDirectory,
    summary: {
      ok: count("ok"),
      warning: count("warning"),
      failed: count("failed"),
      skipped: count("skipped"),
      total: checks.length,
    },
    checks,
  } satisfies DoctorReport;
});
