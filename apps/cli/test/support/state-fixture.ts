import { expect } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import type { State } from "../../src/domain/state/state-schema.ts";
import { stateFormat } from "../../src/domain/state/state-format.ts";
import { StateBusyError, type StateOptions } from "../../src/services/state-store.ts";
import { encodeState } from "../../src/domain/state/state-codec.ts";
import { initializeState, mutateState } from "../../src/services/state-store.ts";
import type { JournalEntry, StateProject } from "../../src/domain/state/state-schema.ts";
import type { ReconciliationAction } from "../../src/domain/reconciliation/reconciliation-schema.ts";
import type { SkillChoice } from "../../src/domain/choices/choice-schema.ts";
import {
  docsLink,
  type DocsManagedLink,
  type DocsProject,
} from "../../src/domain/docs/docs-schema.ts";
import { projectRecordView } from "../../src/domain/projects/project-schema.ts";
import {
  agentLink,
  linkEvidenceEqual,
  managedLinksOf,
  pendingRemovalsOf,
  type LinkRecord,
} from "../../src/domain/links/link-record-schema.ts";
import type {
  ManagedLinkEvidence,
  ManagedLinkTarget,
} from "../../src/domain/links/managed-link-schema.ts";
import type { AgentAdapterId } from "../../src/domain/links/agent-adapter-schema.ts";
import { managedLinkDestinationPath } from "../../src/domain/agents/agent-layout.ts";
import type { PendingRemoval } from "../../src/domain/links/pending-removal-schema.ts";
import { compareCodeUnits } from "../../src/domain/identity/ordering.ts";

/** Orders records the way a state file lists them: by destination. */
const canonicalLinkOrder = (records: ReadonlyArray<LinkRecord>): LinkRecord[] =>
  [...records].sort((left, right) => compareCodeUnits(left.destinationPath, right.destinationPath));

type FixtureProject = Omit<StateProject, "removingRoots"> & {
  readonly removingRoots?: ReadonlyArray<string>;
};

/** The journal entry a fixture authored in the shape of the one prepared agent action. */
type PreparedAgentAction =
  | { readonly action: ReconciliationAction }
  | {
      readonly action:
        | {
            readonly _tag: "link-create";
            readonly evidence: ManagedLinkEvidence;
            readonly previousEvidence?: ManagedLinkEvidence;
          }
        | { readonly _tag: "link-remove"; readonly evidence: ManagedLinkEvidence };
    };

/** The data of a flat fixture: runtime collections, optional, plus the parallel lists and flat intent. */
export type FixtureData = Partial<Omit<State["data"], "projects" | "journal">> & {
  readonly projects?: ReadonlyArray<FixtureProject>;
  /** Evidence that is managed with nothing owed, unless `pendingRemovals` also names it. */
  readonly managedLinks?: ReadonlyArray<ManagedLinkEvidence>;
  /** Owed removals, which merge into the link record of the same destination. */
  readonly pendingRemovals?: ReadonlyArray<PendingRemoval>;
  /** Docs mounts, recorded in the same ledger as agent links. */
  readonly docsManagedLinks?: ReadonlyArray<DocsManagedLink>;
  readonly choices?: ReadonlyArray<SkillChoice>;
  readonly docsProjects?: ReadonlyArray<DocsProject>;
  readonly reconciliationJournal?: PreparedAgentAction;
  readonly docsJournal?: {
    readonly action: "create" | "remove";
    readonly evidence: DocsManagedLink;
  };
  readonly journal?: ReadonlyArray<JournalEntry>;
};

/** A state written the way tests wrote it before link records: parallel lists and flat intent. */
export type FlatFixture = {
  /** Ignored: kept so fixtures authored with an envelope version still read. */
  readonly version?: number;
  readonly format?: State["format"];
  readonly data: FixtureData;
};

/** Merges parallel managed and pending lists into one link record per destination. */
const linkRecordsFrom = (
  managed: ReadonlyArray<ManagedLinkEvidence>,
  pending: ReadonlyArray<PendingRemoval>,
): LinkRecord[] => {
  const records: LinkRecord[] = managed.map((evidence) => agentLink(evidence));
  for (const item of pending) {
    const { evidence, ...removal } = item;
    const link = agentLink(evidence);
    const index = records.findIndex((record) => linkEvidenceEqual(record, link));
    const existing = records[index];
    if (existing === undefined) records.push({ ...link, removal, pendingOnly: true });
    else records[index] = { ...existing, removal };
  }
  return canonicalLinkOrder(records);
};

const journalFrom = (fixture: FixtureData): ReadonlyArray<JournalEntry> | undefined => {
  const entries: JournalEntry[] = [...(fixture.journal ?? [])];
  const action = fixture.reconciliationJournal?.action;
  if (action?._tag === "link-create")
    entries.push(
      action.previousEvidence === undefined
        ? { _tag: "create", link: agentLink(action.evidence) }
        : {
            _tag: "replace",
            link: agentLink(action.evidence),
            previous: agentLink(action.previousEvidence),
          },
    );
  if (action?._tag === "link-remove")
    entries.push({ _tag: "remove", link: agentLink(action.evidence) });
  if (fixture.docsJournal !== undefined)
    entries.push({
      _tag: fixture.docsJournal.action,
      link: docsLink(fixture.docsJournal.evidence),
    });
  return entries.length === 0 ? undefined : entries;
};

/** Carries a fixture authored with flat lists into the runtime model: complete, nested and merged. */
export const runtimeFixture = (fixture: FlatFixture): State => {
  const {
    choices,
    docsJournal: _docsJournal,
    docsManagedLinks,
    docsProjects,
    journal: _journal,
    links,
    managedLinks,
    pendingRemovals,
    projects: authoredProjects,
    reconciliationJournal: _reconciliationJournal,
    ...data
  } = fixture.data;
  const projects = (authoredProjects ?? []).map((project) => {
    const projectChoices = (choices ?? []).filter(
      (choice) =>
        choice.namespace._tag === "project" && choice.namespace.projectName === project.name,
    );
    const settings = docsProjects?.find((entry) => entry.projectName === project.name);
    return {
      ...project,
      removingRoots: project.removingRoots ?? [],
      ...(projectChoices.length === 0
        ? {}
        : { choices: projectChoices.map(({ address, decision }) => ({ address, decision })) }),
      ...(settings === undefined
        ? {}
        : {
            docs: {
              attachments: settings.attachments.map((resource) => ({
                ...resource,
                ...(settings.defaultWritingResource !== undefined &&
                resource.sourceRegistrationId ===
                  settings.defaultWritingResource.sourceRegistrationId &&
                resource.name === settings.defaultWritingResource.name
                  ? { writingDefault: true as const }
                  : {}),
              })),
              ...(settings.destination === undefined ? {} : { destination: settings.destination }),
            },
          }),
    };
  });
  const userChoices = (choices ?? [])
    .filter((choice) => choice.namespace._tag === "user")
    .map(({ address, decision }) => ({ address, decision }));
  const journal = journalFrom(fixture.data);
  // Parallel agent lists replace the agent records only: docs mounts in `links` stay.
  const agentRecords =
    managedLinks === undefined && pendingRemovals === undefined
      ? (links ?? [])
      : [
          ...linkRecordsFrom(
            managedLinks ?? managedLinksOf(links ?? []),
            pendingRemovals ?? pendingRemovalsOf(links ?? []),
          ),
          ...(links ?? []).filter((record) => record.delivery._tag === "docs"),
        ];
  return {
    format: fixture.format ?? stateFormat,
    data: {
      enabledAdapters: [],
      sources: [],
      ...data,
      projects,
      userChoices: data.userChoices ?? userChoices,
      ...(journal === undefined ? {} : { journal }),
      links: canonicalLinkOrder([
        ...agentRecords,
        ...(docsManagedLinks ?? []).map((evidence) => docsLink(evidence)),
      ]),
    },
  };
};

/**
 * Persists a replacement under the writer lock. The replacement may be authored with flat lists and
 * partial projects, and it is carried into the runtime model before validation.
 */
export const mutateStateFixture = (options: StateOptions, update: (state: State) => FlatFixture) =>
  mutateState(options, (state) => {
    const candidate = runtimeFixture(update(state));
    return Effect.succeed({ state: candidate, value: candidate });
  });

/** Compares historical project registration fields while intent is asserted separately. */
export const projectRecords = (state: State) =>
  state.data.projects.map((project) => projectRecordView(project));

/** Serializes a validated runtime fixture through the production disk codec. */
export const encodeStateFixture = (state: FlatFixture): string =>
  JSON.stringify(Effect.runSync(encodeState(runtimeFixture(state))));

/** The temporary world of a state test: a canonical root with an initialized state below it. */
export type StateFixture = {
  readonly options: StateOptions & {
    readonly environment: { readonly TACK_STATE_DIR: string };
    readonly homeDirectory: string;
  };
  readonly root: string;
  readonly stateDirectory: string;
  readonly statePath: string;
};

/**
 * Runs `use` in a fresh canonical temporary root whose `home` directory exists and whose `state`
 * directory holds an initialized state.
 */
export const withStateFixture = <A, E, R>(use: (fixture: StateFixture) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-state-" }),
    );
    const stateDirectory = path.join(root, "state");
    const options = {
      environment: { TACK_STATE_DIR: stateDirectory },
      homeDirectory: path.join(root, "home"),
    };
    yield* fileSystem.makeDirectory(options.homeDirectory, { recursive: true });
    yield* initializeState(options);
    return yield* use({
      options,
      root,
      stateDirectory,
      statePath: path.join(stateDirectory, "state.json"),
    });
  });

/**
 * Asserts that `run` is refused with `StateBusyError` while another writer holds the state lock in
 * `stateDirectory`, then releases that lock. The store tests own busy and corrupt state; a feature
 * that writes state keeps this one test to show its writes go through the lock, and asserts what
 * `run` left untouched.
 */
export const expectWriterGuarded = <A, E, R>(stateDirectory: string, run: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = path.join(stateDirectory, "state.lock");
    yield* fileSystem.writeFileString(lockPath, "busy");
    const error = yield* Effect.flip(run);
    yield* fileSystem.remove(lockPath);
    expect(error).toBeInstanceOf(StateBusyError);
  });

/** The registration id that fixture evidence names for its source. */
export const fixtureSourceId = "00000000-0000-4000-8000-000000000001";

/** A project-root link target. */
export const targetProject = (projectName: string, canonicalPath: string) =>
  ({ _tag: "project-root", canonicalPath, projectName }) satisfies ManagedLinkTarget;

/** A user link target. */
export const targetUser = (canonicalPath: string) =>
  ({ _tag: "user", canonicalPath }) satisfies ManagedLinkTarget;

/** Evidence of one managed link to the resource `name` of the fixture source. */
export const evidenceFor = (
  adapter: AgentAdapterId,
  target: ManagedLinkTarget,
  sourceDirectoryPath: string,
  name: string,
  kind: "command" | "skill" = "skill",
): ManagedLinkEvidence => ({
  adapter,
  address: { kind, name, sourceRegistrationId: fixtureSourceId },
  sourceDirectoryPath,
  sourceRegistrationId: fixtureSourceId,
  target,
});

/** Creates a relative symbolic link at `destination` to `source`, with its parent directories. */
export const relativeLink = Effect.fnUntraced(function* (destination: string, source: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
  yield* fileSystem.symlink(path.relative(path.dirname(destination), source), destination);
  return destination;
});

/**
 * Lays out the link that `evidence` records: its source (a directory, or a command file) and a
 * relative link at its derived destination. Returns the destination.
 */
export const setupLink = Effect.fnUntraced(function* (evidence: ManagedLinkEvidence) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (evidence.address.kind === "command") {
    yield* fileSystem.makeDirectory(path.dirname(evidence.sourceDirectoryPath), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(evidence.sourceDirectoryPath, "# Command\n");
  } else yield* fileSystem.makeDirectory(evidence.sourceDirectoryPath, { recursive: true });
  return yield* relativeLink(managedLinkDestinationPath(evidence), evidence.sourceDirectoryPath);
});
