import { Effect, Path, Result } from "effect";
import { withStateCheckpointWriter, type StateOptions } from "../../services/state-store.ts";
import { type State } from "../../domain/state/state-schema.ts";
import { readInvocationSnapshot } from "../snapshot/command-snapshot.ts";
import { managedLinksOf } from "../../domain/links/link-record-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { allSkillChoices } from "../../domain/state/state-intent.ts";
import { inspectSourcesFromState } from "../sources/source.ts";
import { sourceDisplayName } from "./import-destination.ts";
import { importFailure } from "./import-error.ts";
import { importStateOf, observeImports, type SourceImport } from "./import-inspect.ts";
import type {
  ImportRemovalApplication,
  ImportRemovalPlan,
} from "../../domain/imports/import-schema.ts";
import { recoverStaging, removeImports } from "./import-write.ts";
import { compareFolderToRecord, localChangeSummary, type LocalChange } from "./local-change.ts";
import { declarationFileName } from "../sources/declaration-file.ts";

/** The command that lists imported skills. */
const listImports = ["tack", "import"];

/** Finds the imported skill a `name` or `source:name` reference names, without guessing. */
const resolveImport = (imports: ReadonlyArray<SourceImport>, reference: string) => {
  const colon = reference.indexOf(":");
  const qualified = imports.filter(
    (item) =>
      item.reference === reference ||
      (colon >= 0 &&
        item.inspection.registration.id === reference.slice(0, colon) &&
        item.name === reference.slice(colon + 1)),
  );
  const matches =
    qualified.length > 0 ? qualified : imports.filter((item) => item.name === reference);
  const [only] = matches;
  if (only !== undefined && matches.length === 1) return Effect.succeed(only);
  const known = imports.map((item) => item.reference);
  return Effect.fail(
    matches.length === 0
      ? importFailure(
          "import-not-found",
          `No imported skill matches ${JSON.stringify(reference.slice(0, 80))}. ${
            known.length === 0
              ? `Nothing has been imported; \`${listImports.join(" ")}\` lists imported skills.`
              : `Imported skills: ${known.join(", ")}.`
          }`,
          { imported: known },
          known.length === 0 ? [listImports] : undefined,
        )
      : importFailure(
          "import-not-found",
          `${reference} matches several imported skills. Use ${matches.map((item) => item.reference).join(" or ")}.`,
          { candidates: matches.map((item) => item.reference) },
        ),
  );
};

const namespaceText = (namespace: { readonly _tag: string; readonly projectName?: string }) =>
  namespace._tag === "user" ? "user" : `project ${namespace.projectName ?? ""}`;

/** Settles the staging folder of every healthy registered source that holds one. */
const recoverEverywhere = Effect.fnUntraced(function* (state: State) {
  const inspections = yield* inspectSourcesFromState(state);
  const lines = yield* Effect.forEach(
    inspections.filter(
      (inspection) => inspection.status === "healthy" && inspection.origin !== "builtin",
    ),
    (inspection) =>
      recoverStaging(inspection.registration.canonicalPath).pipe(
        // A source whose imports cannot be settled must not block the removal of another.
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
      ),
  );
  return lines.flat();
});

const planFor = Effect.fnUntraced(function* (state: State, reference: string, force: boolean) {
  const path = yield* Path.Path;
  const inspections = yield* inspectSourcesFromState(state);
  const observed = yield* observeImports(inspections);
  const item = yield* resolveImport(observed.imports, reference);
  const { record, inspection } = item;
  const folder = path.join(inspection.registration.canonicalPath, record.path);
  const change = yield* compareFolderToRecord(folder, record);
  const own = inspection.registration.id;
  const delivered = [
    ...new Set(
      managedLinksOf(state.data.links)
        .filter(
          (evidence) =>
            evidence.sourceRegistrationId === own &&
            evidence.address.kind === "skill" &&
            evidence.address.name === item.name,
        )
        .map((evidence) =>
          evidence.target._tag === "user" ? "user" : `project ${evidence.target.projectName}`,
        ),
    ),
  ].sort(compareCodeUnits);
  const picks = allSkillChoices(state)
    .filter(
      (choice) =>
        choice.address.kind === "skill" &&
        choice.address.name === item.name &&
        choice.address.sourceRegistrationId === own,
    )
    .map((choice) => ({
      namespace: namespaceText(choice.namespace),
      address: `${choice.decision} ${choice.address.name}`,
    }));
  const plan: ImportRemovalPlan = {
    kind: "import-removal-plan",
    reference: item.reference,
    source: sourceDisplayName(inspection),
    registrationId: own,
    name: item.name,
    path: record.path,
    location: record.location,
    revision: record.revision,
    folderPresent: change.state !== "missing",
    files: record.files.length,
    local: importStateOf(change),
    delivered,
    picks,
    force,
  };
  return { plan, item, change };
});

/** Refuses to delete a locally changed folder unless the operator forced it. */
const refuseLocalChanges = (item: SourceImport, change: LocalChange, force: boolean) =>
  change.state === "changed" && force === false
    ? importFailure(
        "import-removal-blocked",
        `${item.record.path} has local changes (${localChangeSummary(change)}). Removing it deletes them and Tack keeps no copy. Repeat with --force to see the full list and delete it anyway.`,
        { changes: localChangeSummary(change) },
      )
    : undefined;

/**
 * Previews the removal of one imported skill, offline: what is deleted and what it affects. A
 * locally changed folder is refused unless `force`, which lists every change that will be lost.
 */
export const planImportRemoval = (stateOptions: StateOptions, reference: string, force: boolean) =>
  Effect.gen(function* () {
    const { state } = yield* readInvocationSnapshot(stateOptions);
    const { plan, item, change } = yield* planFor(state, reference, force);
    const refusal = refuseLocalChanges(item, change, force);
    return refusal === undefined ? plan : yield* refusal;
  });

/**
 * Deletes one imported skill's folder and record under the writer lock. A locally changed folder
 * needs `force`; Tack keeps no copy of what it deletes. A record whose folder is gone drops alone.
 */
export const removeImport = (stateOptions: StateOptions, reference: string, force: boolean) =>
  withStateCheckpointWriter(stateOptions, (writer) =>
    Effect.gen(function* () {
      const first = yield* planFor(writer.current(), reference, force).pipe(Effect.result);
      // A removal killed after its record was rewritten leaves a reference that no longer
      // resolves but a staging folder that still needs settling, so every source is settled.
      const recovered = Result.isSuccess(first)
        ? yield* recoverStaging(first.success.item.inspection.registration.canonicalPath)
        : yield* recoverEverywhere(writer.current());
      const second = yield* planFor(writer.current(), reference, force).pipe(Effect.result);
      if (Result.isFailure(second)) {
        const name = reference.slice(reference.indexOf(":") + 1);
        const finished = recovered.find(
          (line) =>
            line.startsWith("Finished the interrupted removal of ") && line.endsWith(`/${name}.`),
        );
        // The interrupted removal of this very skill was the one just finished.
        if (finished !== undefined)
          return {
            plan: undefined,
            applied: {
              kind: "import-removal-application",
              reference,
              removed: [],
              recovered,
            } satisfies ImportRemovalApplication,
          };
        return yield* second.failure;
      }
      const { plan, item, change } = second.success;
      const refusal = refuseLocalChanges(item, change, force);
      if (refusal !== undefined) return yield* refusal;
      yield* removeImports(item.inspection.registration.canonicalPath, [
        { path: item.record.path, record: item.record, folderPresent: plan.folderPresent },
      ]);
      const applied: ImportRemovalApplication = {
        kind: "import-removal-application",
        reference: item.reference,
        removed: [...(plan.folderPresent ? [`${item.record.path}/`] : []), declarationFileName],
        recovered,
      };
      return { plan, applied };
    }),
  );
