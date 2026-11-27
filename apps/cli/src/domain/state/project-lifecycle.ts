import { sortAndDedupeStrings } from "../identity/ordering.ts";
import type { State, StateProject } from "./state-schema.ts";
import { projectLifecycle } from "../projects/project-schema.ts";

/**
 * The lifecycle of a registered project as pure state transitions. A root is active, handed off
 * (its links are still owed a cleanup) or gone; a project with no root left is forgotten. Removal and
 * refresh decide which transition applies, and only this module edits the project registrations.
 */

/** The roots one move changes for a single project; every list holds canonical roots. */
export type ProjectRootMoves = {
  /** New active roots. */
  readonly additions?: ReadonlyArray<string>;
  /** Active roots that leave the project without owing any cleanup. */
  readonly deregistrations?: ReadonlyArray<string>;
  /** Active roots that leave the project while their links are owed a cleanup. */
  readonly handoffs?: ReadonlyArray<string>;
  /** Handed-off roots that become active again. */
  readonly reactivations?: ReadonlyArray<string>;
};

const sameRoots = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((root, index) => root === right[index]);

/** The project with its roots moved; root order stays canonical. */
const movedProject = (project: StateProject, moves: ProjectRootMoves): StateProject => {
  const leaving = new Set([...(moves.handoffs ?? []), ...(moves.deregistrations ?? [])]);
  const reactivated = new Set(moves.reactivations ?? []);
  return {
    ...project,
    removingRoots: sortAndDedupeStrings([
      ...project.removingRoots.filter((root) => reactivated.has(root) === false),
      ...(moves.handoffs ?? []),
    ]),
    roots: sortAndDedupeStrings([
      ...project.roots.filter((root) => leaving.has(root) === false),
      ...(moves.additions ?? []),
      ...(moves.reactivations ?? []),
    ]),
  };
};

/**
 * Replaces one registered project with what `update` returns, or forgets it for `undefined`. An
 * unregistered project, or an update that returns the same record, leaves the state as it was.
 */
const updateProject = (
  state: State,
  projectName: string,
  update: (project: StateProject) => StateProject | undefined,
): State => {
  const project = state.data.projects.find((candidate) => candidate.name === projectName);
  if (project === undefined) return state;
  const next = update(project);
  if (next === project) return state;
  const projects =
    next === undefined
      ? state.data.projects.filter((candidate) => candidate !== project)
      : state.data.projects.map((candidate) => (candidate === project ? next : candidate));
  return { ...state, data: { ...state.data, projects } };
};

/** Drops the fixed profile applications of projects that are no longer registered. */
const withoutUnregisteredApplications = (state: State): State => {
  const applications = state.data.profileApplications;
  if (applications === undefined) return state;
  const registered = new Set(state.data.projects.map((project) => project.name));
  return {
    ...state,
    data: {
      ...state.data,
      profileApplications: applications.filter(
        (application) =>
          application.namespace._tag === "user" ||
          registered.has(application.namespace.projectName),
      ),
    },
  };
};

/**
 * Hands one root off: it leaves the active roots and stays as a handoff root until its links are
 * cleaned up. `requestProjectRemoval` also records the operator's intent to remove the project.
 */
export const handOffRoot = (
  state: State,
  projectName: string,
  root: string,
  options?: { readonly requestProjectRemoval: boolean },
): State =>
  updateProject(state, projectName, (project) => ({
    ...movedProject(project, { handoffs: [root] }),
    ...(options?.requestProjectRemoval === true ? { removalIntent: "project" as const } : {}),
  }));

/** Hands every root of a project off and records the operator's intent to remove it. */
export const handOffProject = (state: State, projectName: string): State =>
  updateProject(state, projectName, (project) => ({
    ...movedProject(project, { handoffs: [...project.roots, ...project.removingRoots] }),
    removalIntent: "project",
  }));

/**
 * Applies one refresh's root moves to a project at once. A project left with no root is forgotten,
 * with its fixed profile application.
 */
export const moveProjectRoots = (
  state: State,
  projectName: string,
  moves: ProjectRootMoves,
): State => {
  const next = updateProject(state, projectName, (project) => {
    const moved = movedProject(project, moves);
    if (moved.roots.length === 0 && moved.removingRoots.length === 0) return undefined;
    return sameRoots(moved.roots, project.roots) &&
      sameRoots(moved.removingRoots, project.removingRoots)
      ? project
      : moved;
  });
  return next.data.projects.length === state.data.projects.length
    ? next
    : withoutUnregisteredApplications(next);
};

/** Forgets a project and its fixed profile application. */
export const removeProject = (state: State, projectName: string): State => {
  const next = updateProject(state, projectName, () => undefined);
  return next === state ? state : withoutUnregisteredApplications(next);
};

/**
 * Forgets one root whose cleanup has settled, active or handed off. The project goes, with its
 * fixed profile application, when that was its last root.
 */
export const finalizeRoot = (state: State, projectName: string, root: string): State => {
  const next = updateProject(state, projectName, (project) => {
    const roots = project.roots.filter((candidate) => candidate !== root);
    const removingRoots = project.removingRoots.filter((candidate) => candidate !== root);
    return roots.length === 0 && removingRoots.length === 0
      ? undefined
      : { ...project, roots, removingRoots };
  });
  return next.data.projects.length === state.data.projects.length
    ? next
    : withoutUnregisteredApplications(next);
};

const holdsAgentLinks = (state: State, projectName: string, root?: string) =>
  state.data.links.some(
    (record) =>
      record.delivery._tag === "agent" &&
      record.target._tag === "project-root" &&
      record.target.projectName === projectName &&
      (root === undefined || record.target.canonicalPath === root),
  );

/**
 * Forgets the handoff roots that hold no agent link any more, for every project or only the
 * selected ones. A removing project with no agent link left anywhere goes, with its fixed profile
 * application; one that still holds a link outside its handoff roots keeps all of them.
 */
export const finalizeHandoffs = (
  state: State,
  selectedProjectNames?: ReadonlySet<string>,
): State => {
  const projects = state.data.projects.flatMap((project): StateProject[] => {
    if (selectedProjectNames !== undefined && selectedProjectNames.has(project.name) === false) {
      return [project];
    }
    const handoffRoots = project.removingRoots;
    if (handoffRoots.length === 0) return [project];
    const retainedRoots = handoffRoots.filter((root) => holdsAgentLinks(state, project.name, root));
    const removing = projectLifecycle(project) === "removing";
    const holdsAnyLink = holdsAgentLinks(state, project.name);
    if (removing === true && retainedRoots.length === 0 && holdsAnyLink === false) return [];
    return [
      {
        ...project,
        removingRoots: removing === true && holdsAnyLink === true ? handoffRoots : retainedRoots,
      },
    ];
  });
  const changed =
    projects.length !== state.data.projects.length ||
    projects.some((project, index) => project !== state.data.projects[index]);
  if (changed === false) return state;
  return withoutUnregisteredApplications({ ...state, data: { ...state.data, projects } });
};
