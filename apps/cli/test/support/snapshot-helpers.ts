import { Effect } from "effect";
import {
  listSkillChoices as listSkillChoicesOf,
  removeSkillChoice as removeSkillChoiceOn,
  setSkillChoice as setSkillChoiceOn,
} from "../../src/features/choices/choice.ts";
import { readInvocationSnapshot } from "../../src/features/snapshot/command-snapshot.ts";
import { inspectSourcesWithDeclarations as declarationsOf } from "../../src/features/sources/catalog.ts";
import { inspectProjects, selectTargets } from "../../src/features/projects/project.ts";
import { publicSourceInspection } from "../../src/features/sources/source.ts";
import {
  readState,
  withStateCheckpointWriter,
  type StateOptions,
} from "../../src/services/state-store.ts";

/*
 * Tests call the features through the state options they build, the way an operator's command
 * names its state directory. These helpers take one snapshot or one writer session per call, as
 * the host does for one command.
 */

type SetChoice = Parameters<typeof setSkillChoiceOn>[1];
type RemoveChoice = Parameters<typeof removeSkillChoiceOn>[1];

/** Persists one exact choice in its own writer session. */
export const setSkillChoice = (options: StateOptions, choice: SetChoice) =>
  withStateCheckpointWriter(options, (writer) => setSkillChoiceOn(writer, choice));

/** Removes one exact choice in its own writer session. */
export const removeSkillChoice = (options: StateOptions, remove: RemoveChoice) =>
  withStateCheckpointWriter(options, (writer) => removeSkillChoiceOn(writer, remove));

/** Lists the choices of the state that `options` names, read once. */
export const listSkillChoices = (
  options: StateOptions,
  namespace?: Parameters<typeof listSkillChoicesOf>[1],
) => readState(options).pipe(Effect.flatMap((state) => listSkillChoicesOf(state, namespace)));

/** Resolves the catalog of the state that `options` names, read once. */
export const resolveCatalogAt = (options: StateOptions) =>
  readInvocationSnapshot(options).pipe(Effect.flatMap((snapshot) => snapshot.catalog));

/** Inspects the sources of the state that `options` names, read once. */
export const inspectSourcesAt = (options: StateOptions) =>
  readInvocationSnapshot(options).pipe(
    Effect.flatMap((snapshot) => snapshot.sourceInspections),
    Effect.map((inspections) => inspections.map(publicSourceInspection)),
  );

/** Inspects the sources with the declarations each contributes, from one catalog resolution. */
export const inspectSourcesWithDeclarations = (options: StateOptions) =>
  resolveCatalogAt(options).pipe(Effect.map(declarationsOf));

/** Selects targets from the state that `options` names, read once. */
export const selectTargetsAt = (
  options: StateOptions,
  selection: Parameters<typeof selectTargets>[2],
) => readState(options).pipe(Effect.flatMap((state) => selectTargets(state, options, selection)));

/** Inspects the projects of the state that `options` names, read once. */
export const inspectProjectsAt = (options: StateOptions) =>
  readState(options).pipe(Effect.flatMap(inspectProjects));
