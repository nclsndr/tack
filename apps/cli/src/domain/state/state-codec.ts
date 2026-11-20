import { Effect, Schema } from "effect";
import { docsResourceIdentity } from "../docs/docs-schema.ts";
import { resourceAddressIdentity } from "../sources/catalog-schema.ts";
import {
  linkEvidenceEqual,
  physicalDestinationIdentity,
  type LinkRecord,
} from "../links/link-record-schema.ts";
import { compareCodeUnits } from "../identity/ordering.ts";
import { StateSchema, type State } from "./state-schema.ts";

const byKey = <A>(values: ReadonlyArray<A>, key: (value: A) => string): A[] =>
  [...values].sort((left, right) => compareCodeUnits(key(left), key(right)));

const strict = { onExcessProperty: "error" } as const;

/** Cross-collection invariants that the per-collection schemas cannot express. */
const ownershipIssues = (state: State): string[] => {
  const journal = state.data.journal;
  if (journal === undefined) return [];
  const retained = new Map<string, LinkRecord>(
    state.data.links.map((record) => [physicalDestinationIdentity(record.destinationPath), record]),
  );
  const issues: string[] = [];
  for (const entry of journal) {
    const record = retained.get(physicalDestinationIdentity(entry.link.destinationPath));
    if (record === undefined || linkEvidenceEqual(record, entry.link)) continue;
    // A replacement may retain its old managed evidence before the new create settles, but only
    // while no removal is owed for it.
    if (
      entry._tag === "replace" &&
      record.removal === undefined &&
      linkEvidenceEqual(record, entry.previous)
    )
      continue;
    issues.push("Prepared links must agree with retained ownership or exact replacement evidence.");
  }
  return issues;
};

/** The runtime model a checkpoint may persist: the feature schema plus cross-collection ownership. */
const PersistableStateSchema = StateSchema.check(
  Schema.makeFilter((state) => ownershipIssues(state)),
);

/** Validates a state document against its supported format schema, refusing unknown fields. */
const validatePersistableState = Schema.decodeUnknownEffect(PersistableStateSchema, strict);

/** Decodes the state document of the current format. */
export const decodeState = (input: unknown): Effect.Effect<State, Schema.SchemaError> =>
  validatePersistableState(input);

/** The link record as the document spells it, with the identity fields before the obligation. */
const linkRecordOf = (record: LinkRecord): LinkRecord => ({
  destinationPath: record.destinationPath,
  sourceDirectoryPath: record.sourceDirectoryPath,
  resource: record.resource,
  target: record.target,
  delivery: record.delivery,
  ...(record.removal === undefined ? {} : { removal: record.removal }),
  ...(record.pendingOnly === true ? { pendingOnly: true as const } : {}),
});

/**
 * Validates and canonically orders the state document for stable, readable bytes. `format` is the
 * document's first field: routing a file reads nothing else.
 */
export const encodeState = (input: State): Effect.Effect<State, Schema.SchemaError> =>
  validatePersistableState(input).pipe(
    Effect.map((state) => ({
      format: state.format,
      data: {
        enabledAdapters: [...state.data.enabledAdapters].sort(compareCodeUnits),
        sources: byKey(state.data.sources, (source) => source.id),
        ...(state.data.profileApplications === undefined
          ? {}
          : { profileApplications: state.data.profileApplications }),
        projects: byKey(state.data.projects, (project) => project.name).map((project) => ({
          name: project.name,
          gitCommonDirectory: project.gitCommonDirectory,
          roots: [...project.roots].sort(compareCodeUnits),
          removingRoots: [...project.removingRoots].sort(compareCodeUnits),
          ...(project.removalIntent === undefined ? {} : { removalIntent: project.removalIntent }),
          ...(project.choices === undefined
            ? {}
            : {
                choices: byKey(project.choices, (choice) =>
                  resourceAddressIdentity(choice.address),
                ),
              }),
          ...(project.docs === undefined
            ? {}
            : {
                docs: {
                  attachments: byKey(project.docs.attachments, (attachment) =>
                    docsResourceIdentity(attachment),
                  ),
                  ...(project.docs.destination === undefined
                    ? {}
                    : { destination: project.docs.destination }),
                },
              }),
        })),
        userChoices: byKey(state.data.userChoices, (choice) =>
          resourceAddressIdentity(choice.address),
        ),
        links: byKey(state.data.links, (record) => record.destinationPath).map(linkRecordOf),
        ...(state.data.journal === undefined ? {} : { journal: state.data.journal }),
      },
    })),
  );
