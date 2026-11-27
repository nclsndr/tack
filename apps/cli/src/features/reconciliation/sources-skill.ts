import { Effect, FileSystem, Path } from "effect";
import { choiceNamespaceIdentity, type Namespace } from "../../domain/choices/choice-schema.ts";
import { selectedDependencyAddresses } from "../../domain/choices/dependency-resolution.ts";
import { isLinkableAddress, type SkillCatalogEntry } from "../../domain/sources/catalog-schema.ts";
import type { NamespaceDependencyResolution } from "../../domain/reconciliation/reconciliation-schema.ts";
import {
  generatedSkillRegistrationId,
  renderSourcesSkill,
  sourcesSkillDescription,
  sourcesSkillName,
  type SourcesSkillSource,
} from "../../domain/generated/sources-skill.ts";
import type { SourcesSkillReport } from "../../domain/generated/sources-skill-schema.ts";
import type { SourceInspection } from "../../domain/sources/source-inspection.ts";
import { docsSettingsFor } from "../../domain/state/state-intent.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import type { AgentAdapterId } from "../../domain/agents/agent-adapter-schema.ts";
import { agentAdapterDescriptor } from "../../domain/agents/agent-adapter.ts";
import { deliversKind } from "../../domain/agents/agent-layout.ts";
import { StateStorageError } from "../../services/state-store.ts";
import { fileAccessFailure } from "../file-access.ts";
import type { NamespacePlanInput } from "./reconciliation.ts";

/** The folder of Tack's state directory that holds the skills Tack generates. */
const generatedFolder = "generated";

/**
 * One namespace's sources skill: the folder Tack writes it to, its text and the hash of its
 * inputs, and the catalog entry the planner links into each of the namespace's targets.
 */
export type SourcesSkill = {
  readonly namespace: Namespace;
  readonly entry: SkillCatalogEntry;
  readonly inputs: string;
  readonly text: string;
};

/** Where the skills Tack generates for a project live, below the real state directory. */
const projectsFolder = (path: Path.Path, stateDirectory: string) =>
  path.join(stateDirectory, generatedFolder, "projects");

/** The folder of one namespace's sources skill, below the real state directory. */
const skillFolder = (path: Path.Path, stateDirectory: string, namespace: Namespace) =>
  namespace._tag === "project"
    ? path.join(
        projectsFolder(path, stateDirectory),
        namespace.projectName,
        sourcesSkillName(namespace),
      )
    : path.join(stateDirectory, generatedFolder, "user", sourcesSkillName(namespace));

/**
 * The registration IDs of the sources one namespace links: the source of each selected skill and
 * command, and for a project the source of each docs resource it attaches.
 */
const linkedSourceIds = (state: State, selection: NamespaceDependencyResolution) =>
  new Set([
    ...selectedDependencyAddresses(selection.resolution)
      .filter(isLinkableAddress)
      .map((address) => address.sourceRegistrationId),
    ...(selection.namespace._tag === "project"
      ? (docsSettingsFor(state, selection.namespace.projectName)?.attachments ?? []).map(
          (attachment) => attachment.sourceRegistrationId,
        )
      : []),
  ]);

/** What the sources skill shows about one healthy source. */
const skillSource = (
  inspection: Extract<SourceInspection, { status: "healthy" }>,
): SourcesSkillSource => ({
  label: inspection.label ?? inspection.registration.id,
  ...(inspection.description === undefined ? {} : { description: inspection.description }),
  path: inspection.registration.canonicalPath,
  maintainers: inspection.maintainers ?? [],
  ...(inspection.rules === undefined ? {} : { rules: inspection.rules }),
});

/**
 * The sources skill of each namespace that links at least one resource of a healthy source, in
 * the order of `selections`. Sync writes each one and links it; status compares each with the copy
 * on disk. Both derive them here, from the same selections and catalog they plan links from.
 *
 * @param stateDirectory - The real path of the state directory, so a link's recorded target is the
 *   path the operating system resolves it to.
 */
const plannedSourcesSkills = (input: {
  readonly path: Path.Path;
  readonly state: State;
  readonly sources: ReadonlyArray<SourceInspection>;
  readonly selections: ReadonlyArray<NamespaceDependencyResolution>;
  readonly stateDirectory: string;
}): ReadonlyArray<SourcesSkill> =>
  input.selections.flatMap(({ namespace, resolution }): ReadonlyArray<SourcesSkill> => {
    const ids = linkedSourceIds(input.state, { namespace, resolution });
    const sources = input.sources.flatMap((inspection) =>
      inspection.status === "healthy" && ids.has(inspection.registration.id)
        ? [skillSource(inspection)]
        : [],
    );
    if (sources.length === 0) return [];
    const { text, inputs } = renderSourcesSkill({ namespace, sources });
    const directoryPath = skillFolder(input.path, input.stateDirectory, namespace);
    const name = sourcesSkillName(namespace);
    return [
      {
        namespace,
        inputs,
        text,
        entry: {
          activation: "default",
          address: { kind: "skill", name, sourceRegistrationId: generatedSkillRegistrationId },
          dependencies: [],
          description: sourcesSkillDescription,
          directoryPath,
          frontmatter: { name, description: sourcesSkillDescription },
          projects: [],
          skillFilePath: input.path.join(directoryPath, "SKILL.md"),
          sourcePath: input.path.join(input.stateDirectory, generatedFolder),
          sourceRegistrationId: generatedSkillRegistrationId,
        },
      },
    ];
  });

/** The sources skills one command plans, and the folder of the projects' generated skills. */
export type PlannedSourcesSkills = {
  /** The projects the state holds; a project's generated folder outlives none of them. */
  readonly knownProjects: ReadonlyArray<string>;
  readonly projectsFolder: string;
  readonly skills: ReadonlyArray<SourcesSkill>;
};

/**
 * The sources skills of `selections`, from the command snapshot's sources and the real state
 * directory, which exists once the state does.
 */
export const sourcesSkillsFor = Effect.fnUntraced(function* (input: {
  /** The adapters the command links through; a namespace none of them links skills for gets none. */
  readonly adapters: ReadonlyArray<AgentAdapterId>;
  readonly state: State;
  readonly sources: ReadonlyArray<SourceInspection>;
  readonly selections: ReadonlyArray<NamespaceDependencyResolution>;
  readonly stateDirectory: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDirectory = yield* fileSystem.realPath(input.stateDirectory).pipe(
    // Coverage skip: a command reads its state first, so its state directory exists here.
    /* v8 ignore next -- @preserve */
    Effect.orElseSucceed(() => input.stateDirectory),
  );
  return {
    knownProjects: input.state.data.projects.map((project) => project.name),
    projectsFolder: projectsFolder(path, stateDirectory),
    skills: plannedSourcesSkills({
      ...input,
      path,
      selections: input.selections.filter(({ namespace }) =>
        input.adapters.some((adapter) =>
          deliversKind(
            agentAdapterDescriptor(adapter),
            { _tag: namespace._tag === "project" ? "project-root" : "user" },
            "skill",
          ),
        ),
      ),
      stateDirectory,
    }),
  } satisfies PlannedSourcesSkills;
});

/** Whether the copy on disk is the text Tack would write now: `current`, `stale` or `missing`. */
export const observeSourcesSkill = Effect.fnUntraced(function* (skill: SourcesSkill) {
  const fileSystem = yield* FileSystem.FileSystem;
  const written = yield* fileSystem.readFileString(skill.entry.skillFilePath).pipe(
    Effect.map((text) => ({ text }) as const),
    Effect.orElseSucceed(() => undefined),
  );
  return {
    namespace: skill.namespace,
    path: skill.entry.skillFilePath,
    inputs: skill.inputs,
    state: written === undefined ? "missing" : written.text === skill.text ? "current" : "stale",
  } satisfies SourcesSkillReport;
});

/**
 * Writes each sources skill that is not current, through a temporary file renamed into place, so an
 * agent never reads half a skill. Then removes the generated folder of every project the state no
 * longer holds. It runs before any link is created, so a new link never points at nothing.
 */
export const writeSourcesSkills = (
  planned: PlannedSourcesSkills,
  reports: ReadonlyArray<SourcesSkillReport>,
) =>
  writeAll(planned, reports).pipe(
    Effect.mapError((error) => {
      const failure = fileAccessFailure(error, planned.projectsFolder);
      return new StateStorageError({
        message: `Tack could not write its sources skill at ${failure.path}: ${failure.explanation}.`,
        operation: "write the sources skill",
        path: failure.path,
      });
    }),
  );

const writeAll = Effect.fnUntraced(function* (
  { knownProjects, projectsFolder: projects, skills }: PlannedSourcesSkills,
  reports: ReadonlyArray<SourcesSkillReport>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = new Set(
    reports.flatMap((report) => (report.state === "current" ? [report.path] : [])),
  );
  for (const skill of skills) {
    if (current.has(skill.entry.skillFilePath)) continue;
    yield* fileSystem.makeDirectory(skill.entry.directoryPath, { recursive: true });
    // A sync applies under the state's writer lock, so no other Tack writes this name meanwhile.
    const staging = `${skill.entry.skillFilePath}.tmp`;
    yield* fileSystem.writeFileString(staging, skill.text);
    yield* fileSystem.rename(staging, skill.entry.skillFilePath);
  }
  const folders = yield* fileSystem.readDirectory(projects).pipe(Effect.orElseSucceed(() => []));
  for (const folder of folders.toSorted(compareCodeUnits))
    if (knownProjects.includes(folder) === false)
      yield* fileSystem.remove(path.join(projects, folder), { recursive: true, force: true });
});

/** Gives each selection the sources skill of its namespace, which the planner links beside it. */
export const withGeneratedSkills = (
  selections: ReadonlyArray<NamespaceDependencyResolution>,
  skills: ReadonlyArray<SourcesSkill>,
): ReadonlyArray<NamespacePlanInput> =>
  selections.map((selection) => {
    const skill = skills.find(
      (candidate) =>
        choiceNamespaceIdentity(candidate.namespace) ===
        choiceNamespaceIdentity(selection.namespace),
    );
    return skill === undefined ? selection : { ...selection, generated: [skill.entry] };
  });
