import { DateTime, Effect, Path, Result } from "effect";
import { ImportRemote } from "../../services/import-remote.ts";
import { withStateCheckpointWriter, type StateOptions } from "../../services/state-store.ts";
import { type State } from "../../domain/state/state-schema.ts";
import { readInvocationSnapshot } from "../snapshot/command-snapshot.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { resolveCatalog } from "../sources/catalog.ts";
import { inspectSources } from "../sources/source.ts";
import { analyzeCandidates, loadSkillFiles } from "./import-candidates.ts";
import {
  destinationChoices,
  registeredSourcesText,
  resolveDestination,
  resolveDestinationSource,
  skillFolderPath,
  type ImportDestination,
} from "./import-destination.ts";
import { discoverSkillFolders, discoveryPathspecs } from "./import-discovery.ts";
import { ImportError, importFailure, importFileFailure } from "./import-error.ts";
import type { NextCommands } from "../../domain/hints/next-commands.ts";
import { recordFilesOf } from "./import-files.ts";
import { canonicalLocationText, parseImportLocation } from "./import-location.ts";
import { canonicalLocation } from "../../domain/imports/providers/provider.ts";
import { type ImportRecord } from "../../domain/imports/import-record.ts";
import { computeReach } from "./import-reach.ts";
import { resolveRef, type ResolvedRef } from "./import-resolve.ts";
import type {
  ImportApplication,
  ImportCandidate,
  ImportPlan,
  ImportReach,
} from "../../domain/imports/import-schema.ts";
import { destinationVerdict } from "./import-verdict.ts";
import { recoverStaging, writeImports, type StagedImport } from "./import-write.ts";
import { readImportsSection } from "./imports-section.ts";
import { declarationFileName, readDeclarationText } from "../sources/declaration-file.ts";

/** What the operator typed for `import add`. */
export type ImportRequest = {
  readonly location: string;
  /** `SOURCE` or `SOURCE:FOLDER`; required to apply. */
  readonly into?: string | undefined;
  readonly skills: ReadonlyArray<string>;
  readonly all: boolean;
  readonly fullDepth: boolean;
};

/**
 * The command to run instead of a refused one: the corrected location with every other flag the
 * operator typed, as the words of a `tack` command line.
 */
const retypedCommand = (
  request: ImportRequest,
  location: string,
  mode: "preview" | "apply",
): ReadonlyArray<string> => [
  "tack",
  "import",
  "add",
  location,
  ...request.skills.flatMap((skill) => ["--skill", skill]),
  ...(request.all ? ["--all"] : []),
  ...(request.fullDepth ? ["--full-depth"] : []),
  ...(request.into === undefined ? [] : ["--into", request.into]),
  ...(mode === "apply" ? ["--apply"] : []),
];

const refName = (resolved: ResolvedRef) => ({
  kind: resolved.kind,
  ...(resolved.request === undefined ? {} : { request: resolved.request }),
  tracking: resolved.tracking,
});

const rejection = (candidate: ImportCandidate) =>
  candidate.verdict.importable ? "" : `${candidate.verdict.message} (${candidate.verdict.code})`;

/** Matches `--skill` names exactly, then case-insensitively. */
const matchSkill = (candidates: ReadonlyArray<ImportCandidate>, wanted: string) => {
  const exact = candidates.filter((candidate) => candidate.name === wanted);
  return exact.length > 0
    ? exact
    : candidates.filter((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase());
};

/** A candidate with the destination's verdict, and the commands a refusal names as its way past. */
type Judged = { readonly candidate: ImportCandidate; readonly next?: NextCommands };

/**
 * Chooses the candidates an apply would import: `--skill` names, `--all`, or the single candidate.
 * Unknown and not-importable names fail with the names that exist or the reason, and with the
 * commands `fixOf` knows for a refused candidate.
 */
const selectCandidates = (
  candidates: ReadonlyArray<ImportCandidate>,
  request: ImportRequest,
  fixOf: (candidate: ImportCandidate) => NextCommands | undefined,
): Effect.Effect<ReadonlyArray<ImportCandidate>, ImportError> => {
  const visible = candidates.filter((candidate) => candidate.hidden === false);
  if (request.skills.length > 0)
    return Effect.forEach(request.skills, (wanted) =>
      Effect.gen(function* () {
        const [first, ...rest] = matchSkill(candidates, wanted);
        if (first === undefined)
          return yield* importFailure(
            "import-selection-unknown",
            `The location has no skill named ${JSON.stringify(wanted.slice(0, 80))}. Skills found: ${
              visible.length === 0
                ? "none"
                : visible
                    .map((candidate) => candidate.name)
                    .sort(compareCodeUnits)
                    .join(", ")
            }.`,
            { available: visible.map((candidate) => candidate.name) },
          );
        const chosen = [first, ...rest].find((candidate) => candidate.verdict.importable) ?? first;
        return chosen.verdict.importable
          ? chosen
          : yield* importFailure(
              "import-candidate-not-importable",
              `${chosen.name} cannot be imported: ${rejection(chosen)}`,
              undefined,
              fixOf(chosen),
            );
      }),
    ).pipe(
      Effect.map((chosen) =>
        chosen.filter(
          (candidate, index) => chosen.findIndex((other) => other === candidate) === index,
        ),
      ),
    );
  if (request.all)
    return Effect.succeed(visible.filter((candidate) => candidate.verdict.importable === true));
  const [only] = visible;
  return Effect.succeed(
    visible.length === 1 && only !== undefined && only.verdict.importable ? [only] : [],
  );
};

const readRecords = Effect.fnUntraced(function* (destination: ImportDestination) {
  const path = yield* Path.Path;
  const file = path.join(destination.root, declarationFileName);
  const text = yield* readDeclarationText(destination.root).pipe(
    Effect.mapError(() => importFailure("import-records-invalid", `Tack could not read ${file}.`)),
  );
  const section = readImportsSection(text);
  return Result.isSuccess(section)
    ? section.success.records
    : yield* importFailure(
        "import-records-invalid",
        `The imports section of ${file} (line ${section.failure.line}): ${section.failure.message}`,
      );
});

type DestinationOutcome =
  | {
      readonly _tag: "none";
      readonly choices: Effect.Success<ReturnType<typeof destinationChoices>>;
    }
  | { readonly _tag: "resolved"; readonly destination: ImportDestination }
  | { readonly _tag: "refused"; readonly error: ImportError };

/** The import record time in whole seconds, read from the Effect clock. */
const timestamp = DateTime.now.pipe(
  Effect.map((now) => `${DateTime.formatIso(now).slice(0, 19)}Z`),
);

/**
 * One planning pass shared by the preview and the apply: it resolves the ref, fetches, reads the
 * candidates, validates them against the live destination, selects, and computes the reach. An
 * apply continues in the same scope, so the fetched revision is the one written.
 */
const run = Effect.fnUntraced(function* (
  request: ImportRequest,
  state: State,
  mode: "preview" | "apply",
) {
  const parsed = parseImportLocation(request.location);
  if (Result.isFailure(parsed))
    return yield* importFailure(
      "import-location-invalid",
      parsed.failure.message,
      {
        reason: parsed.failure.code,
        ...(parsed.failure.suggestion === undefined
          ? {}
          : {
              suggestion: parsed.failure.suggestion,
              next: retypedCommand(request, parsed.failure.suggestion, mode),
            }),
      },
      parsed.failure.next,
    );
  const location = parsed.success;
  const inspections = yield* inspectSources(state);
  if (mode === "apply" && request.into === undefined)
    return yield* importFailure(
      "import-destination-required",
      `--apply needs --into SOURCE[:FOLDER], the source that receives the skills. ${registeredSourcesText(inspections)}`,
    );
  // A destination that cannot be resolved fails before any network call.
  const source =
    request.into === undefined
      ? undefined
      : yield* resolveDestinationSource(inspections, request.into.split(":")[0] ?? "");
  const folderText =
    request.into === undefined || request.into.includes(":") === false
      ? undefined
      : request.into.slice(request.into.indexOf(":") + 1);
  const recovered =
    mode === "apply" && source !== undefined
      ? yield* recoverStaging(source.registration.canonicalPath)
      : [];
  const destinationResult: DestinationOutcome =
    source === undefined
      ? { _tag: "none", choices: yield* destinationChoices(inspections) }
      : yield* resolveDestination(source, folderText).pipe(
          Effect.map((destination): DestinationOutcome => ({ _tag: "resolved", destination })),
          Effect.catch((error) => Effect.succeed<DestinationOutcome>({ _tag: "refused", error })),
        );
  if (mode === "apply" && destinationResult._tag === "refused")
    return yield* destinationResult.error;

  const remote = yield* ImportRemote;
  const target = location.provider.remote(location);
  const refs = yield* remote.listRefs(target);
  const resolvedRef = resolveRef(location, refs);
  if (Result.isFailure(resolvedRef)) return yield* resolvedRef.failure;
  const resolved = resolvedRef.success;
  const session = yield* remote.open(target, resolved.commit);
  const scope = resolved.scope;
  const listing = yield* session.list(discoveryPathspecs({ scope, fullDepth: request.fullDepth }));
  const folders = discoverSkillFolders(listing, { scope, fullDepth: request.fullDepth });
  const analysis = yield* analyzeCandidates({ session, folders, limits: remote.limits });
  const origin = {
    location: canonicalLocation(location.provider, { repository: location.repository }),
    provider: location.provider,
    revision: resolved.commit,
  };

  const destination =
    destinationResult._tag === "resolved" ? destinationResult.destination : undefined;
  const catalog = destination === undefined ? undefined : yield* resolveCatalog(inspections);
  const records = destination === undefined ? [] : yield* readRecords(destination);
  // A refusal's commands stay beside its candidate: the candidate's verdict is public plan data.
  const judged: ReadonlyArray<Judged> =
    destination === undefined || catalog === undefined
      ? analysis.candidates.map((candidate) => ({ candidate }))
      : yield* Effect.forEach(analysis.candidates, (candidate) =>
          candidate.verdict.importable
            ? destinationVerdict({ destination, catalog, records, origin, candidate }).pipe(
                Effect.map((verdict): Judged =>
                  verdict === undefined
                    ? { candidate }
                    : {
                        candidate: {
                          ...candidate,
                          verdict: {
                            importable: false,
                            code: verdict.code,
                            message: verdict.message,
                          },
                        },
                        ...(verdict.next === undefined ? {} : { next: verdict.next }),
                      },
                ),
              )
            : Effect.succeed({ candidate }),
        );
  const candidates = judged.map(({ candidate }) => candidate);
  const fixes = new Map(
    judged.flatMap(({ candidate, next }) =>
      next === undefined ? [] : [[candidate, next] as const],
    ),
  );
  const selected = yield* selectCandidates(candidates, request, (candidate) =>
    fixes.get(candidate),
  );
  const writes =
    destination === undefined
      ? []
      : selected.map((candidate) => ({
          name: candidate.name,
          path: skillFolderPath(destination.folder, candidate.name),
          upstreamPath: candidate.folder,
          files: candidate.files,
          bytes: candidate.bytes,
        }));
  const reach: ReadonlyArray<ImportReach> =
    destination === undefined || catalog === undefined
      ? []
      : selected.map((candidate) => computeReach({ state, catalog, destination, candidate }));
  const visible = candidates.filter((candidate) => candidate.hidden === false);
  const importable = visible.filter((candidate) => candidate.verdict.importable);
  const outcome: ImportPlan["outcome"] =
    importable.length === 0
      ? "nothing-importable"
      : destinationResult._tag === "refused"
        ? "refused"
        : selected.length === 0
          ? "needs-selection"
          : destination === undefined
            ? "needs-destination"
            : "ready";
  const plan: ImportPlan = {
    kind: "import-plan",
    location:
      resolved.split === undefined
        ? canonicalLocationText({
            provider: location.provider,
            repository: location.repository,
            ...(scope === undefined ? {} : { scope }),
            ...(resolved.request === undefined ? {} : { ref: resolved.request }),
          })
        : resolved.split.explicit,
    provider: location.provider.name,
    transport: location.transport,
    ...(location.urlForm === undefined ? {} : { urlForm: location.urlForm }),
    ref: refName(resolved),
    ...(resolved.split === undefined
      ? {}
      : {
          split: {
            ref: resolved.split.ref,
            ...(scope === undefined ? {} : { scope }),
            explicit: resolved.split.explicit,
          },
        }),
    revision: resolved.commit,
    candidates: visible,
    hiddenInternal: candidates.filter(
      (candidate) => candidate.hidden && selected.includes(candidate) === false,
    ).length,
    selected: selected.map((candidate) => candidate.name),
    ...(destination === undefined
      ? {}
      : {
          destination: {
            source: destination.name,
            registrationId: destination.inspection.registration.id,
            root: destination.root,
            folder: destination.folder,
            declaredFolder: destination.covering.declaredPath,
            newFolders: destination.missingFolders,
          },
        }),
    ...(destinationResult._tag === "none" ? { destinations: destinationResult.choices } : {}),
    ...(destinationResult._tag === "refused"
      ? {
          refusal: { code: destinationResult.error.code, message: destinationResult.error.message },
        }
      : {}),
    writes,
    reach,
    outcome,
  };
  if (mode === "preview") return { plan, applied: undefined };

  if (destination === undefined)
    return yield* importFailure("import-destination-required", "--apply needs --into.");
  const sole = visible.length === 1 ? visible[0] : undefined;
  if (selected.length === 0) {
    if (importable.length === 0)
      return yield* importFailure(
        "import-no-candidates",
        sole === undefined
          ? "Nothing in this location can be imported. Scope it to a folder, or search deeper with --full-depth."
          : `${sole.name} cannot be imported: ${rejection(sole)}`,
        { candidates: visible.map((candidate) => candidate.name) },
      );
    return yield* importFailure(
      "import-selection-required",
      "Several skills can be imported. Choose with --skill NAME (repeatable) or --all, then repeat with --apply.",
      { available: importable.map((candidate) => candidate.name) },
    );
  }
  const treeIds = yield* session.treeIds(selected.map((candidate) => candidate.folder));
  const importedAt = yield* timestamp;
  const staged = yield* Effect.forEach(selected, (candidate) =>
    Effect.gen(function* () {
      const files = yield* loadSkillFiles(session, candidate.folder, analysis.tree);
      const tree = treeIds.get(candidate.folder);
      if (tree === undefined)
        return yield* importFailure(
          "import-write-failed",
          `The remote did not report a tree for ${candidate.folder}. Nothing was changed.`,
        );
      const { files: recordFiles, digest } = recordFilesOf(files);
      const record: ImportRecord = {
        path: skillFolderPath(destination.folder, candidate.name),
        location: origin.location,
        transport: location.transport,
        "ref-kind": resolved.kind,
        ...(resolved.request === undefined ? {} : { ref: resolved.request }),
        revision: resolved.commit,
        "upstream-path": candidate.folder,
        "upstream-tree": tree,
        "imported-at": importedAt,
        digest,
        files: recordFiles,
      };
      const newFolders = destination.missingFolders;
      return {
        name: candidate.name,
        path: record.path,
        files,
        record,
        newFolders,
      } satisfies StagedImport;
    }),
  );
  yield* writeImports(destination.root, staged);
  const applied: ImportApplication = {
    kind: "import-application",
    location: plan.location,
    ref: plan.ref,
    revision: plan.revision,
    destination: plan.destination ?? {
      source: destination.name,
      registrationId: destination.inspection.registration.id,
      root: destination.root,
      folder: destination.folder,
      declaredFolder: destination.covering.declaredPath,
      newFolders: destination.missingFolders,
    },
    imported: writes,
    rejected: visible
      .filter(
        (candidate) =>
          candidate.verdict.importable === false &&
          request.all === true &&
          request.skills.length === 0,
      )
      .map((candidate) => ({
        name: candidate.name,
        folder: candidate.folder,
        code: candidate.verdict.importable ? "" : candidate.verdict.code,
        message: candidate.verdict.importable ? "" : candidate.verdict.message,
      })),
    written: [
      ...destination.missingFolders.map((folder) => `${folder}/`),
      ...writes.map((write) => `${write.path}/`),
      declarationFileName,
    ],
    recovered,
  };
  return { plan, applied };
});

/** Previews an import: nothing is written to the destination or to state. */
export const previewImport = Effect.fn("imports.previewImport")(
  function* (stateOptions: StateOptions, request: ImportRequest) {
    const { state } = yield* readInvocationSnapshot(stateOptions);
    const result = yield* Effect.scoped(run(request, state, "preview"));
    return result.plan;
  },
  (effect, _stateOptions, request) =>
    effect.pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(importFileFailure(request.location)(error)),
      ),
    ),
);

/** Applies an import under the writer lock, re-resolving the ref and validating against the live destination. */
export const applyImport = Effect.fn("imports.applyImport")(function* (
  stateOptions: StateOptions,
  request: ImportRequest,
) {
  return yield* withStateCheckpointWriter(stateOptions, (writer) =>
    Effect.scoped(run(request, writer.current(), "apply")).pipe(
      Effect.flatMap((result) =>
        result.applied === undefined
          ? Effect.die("An apply must produce an application.")
          : Effect.succeed({ plan: result.plan, applied: result.applied }),
      ),
    ),
  ).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(importFileFailure(request.location)(error)),
    ),
  );
});
