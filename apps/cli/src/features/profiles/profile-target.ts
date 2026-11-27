import { generatedSkillRegistrationId } from "../../domain/generated/sources-skill.ts";
import { Source } from "../sources/source.ts";
import { Effect, FileSystem, Path } from "effect";
import { agentAdapterDescriptor } from "../../domain/agents/agent-adapter.ts";
import { choiceNamespaceIdentity, type Namespace } from "../../domain/choices/choice-schema.ts";
import { profileApplicationFor } from "../../domain/profiles/profile-application.ts";
import type { ProfileApplication } from "../../domain/state/profile-application-schema.ts";
import type { ProfilePlanFinding } from "../../domain/profiles/profile-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";
import type { StateOptions } from "../../services/state-store.ts";

export type ProfileTargetRequest = {
  readonly namespace: Namespace;
  readonly targetRoots: ReadonlyArray<string>;
  readonly targetHome?: string;
  readonly force: boolean;
};

/** Establishes the complete physical/intent boundary before any selection or payload write. */
const observeProfileTarget = Effect.fnUntraced(function* (
  state: State,
  options: StateOptions,
  request: ProfileTargetRequest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const findings: ProfilePlanFinding[] = [];
  const namespace = request.namespace;
  const project =
    namespace._tag === "project"
      ? state.data.projects.find((entry) => entry.name === namespace.projectName)
      : undefined;
  const canonical = (value: string) => fs.realPath(path.resolve(value));
  const roots = yield* Effect.forEach(request.targetRoots, canonical);
  const home = request.targetHome === undefined ? undefined : yield* canonical(request.targetHome);
  const targets = namespace._tag === "project" ? roots : home === undefined ? [] : [home];
  if (namespace._tag === "project") {
    const expected = project?.roots ?? [];
    if (
      project === undefined ||
      project.removalIntent !== undefined ||
      roots.length !== expected.length ||
      expected.some((root) => roots.includes(root) === false) ||
      new Set(roots).size !== roots.length ||
      home !== undefined
    )
      findings.push({
        code: "profile-target-boundary",
        message:
          "List every root of the named active project exactly once with --target-root. Force cannot authorize a partial or shared boundary.",
      });
  } else {
    const ordinaryHome =
      options.homeDirectory === undefined ? undefined : yield* canonical(options.homeDirectory);
    const stateDirectory = options.stateDirectory;
    const stateRoot = stateDirectory === undefined ? undefined : yield* canonical(stateDirectory);
    if (
      home === undefined ||
      ordinaryHome !== home ||
      roots.length > 0 ||
      stateRoot === undefined ||
      stateRoot.startsWith(`${home}${path.sep}`) === false
    )
      findings.push({
        code: "profile-target-boundary",
        message:
          "Use --target-home with a matching isolated HOME and an explicit state directory inside that home. A scratch HOME sharing ordinary state is insufficient; force does not waive isolation.",
      });
  }
  const inNamespace = (target: { readonly _tag: string; readonly projectName?: string }) =>
    namespace._tag === "user"
      ? target._tag === "user"
      : target._tag === "project-root" && target.projectName === namespace.projectName;
  const builtinIds = new Set(((yield* Source).builtInSources ?? []).map((source) => source.id));
  // Links to the built-ins and to the skills Tack generates are Tack's own: no profile replaces them.
  const tackOwned = new Set([...builtinIds, generatedSkillRegistrationId]);
  const relevantLinks = state.data.links.filter(
    (link) =>
      inNamespace(link.target) && tackOwned.has(link.resource.sourceRegistrationId) === false,
  );
  const relevantJournal = (state.data.journal ?? []).filter((entry) =>
    inNamespace(entry.link.target),
  );
  const hasChoices =
    namespace._tag === "user"
      ? state.data.userChoices.some(
          (choice) => builtinIds.has(choice.address.sourceRegistrationId) === false,
        )
      : (project?.choices ?? []).some(
          (choice) => builtinIds.has(choice.address.sourceRegistrationId) === false,
        );
  const hasDocs =
    project?.docs !== undefined &&
    (project.docs.attachments.length > 0 || project.docs.destination !== undefined);
  const existing = [
    ...(relevantJournal.length > 0 ? ["target recovery journal"] : []),
    ...(hasChoices ? ["saved picks or exclusions"] : []),
    ...(hasDocs ? ["explicit docs settings"] : []),
    ...(relevantLinks.length > 0 ? ["owned delivery or pending removal records"] : []),
    ...(profileApplicationFor(state, namespace) === undefined
      ? []
      : ["retained fixed application (including empty/incomplete intent)"]),
  ];
  if (existing.length > 0 && request.force === false)
    findings.push({
      code: "profile-existing-selection",
      message: `Existing selection: ${existing.join(", ")}. Review and use --force to replace this complete target's intent.`,
    });
  if (relevantLinks.some((link) => targets.includes(link.target.canonicalPath) === false))
    findings.push({
      code: "profile-target-boundary",
      message:
        "Retained ownership names an unlisted destination. Repair the context or list its complete roots before replacement.",
    });
  if (state.data.journal?.some((entry) => inNamespace(entry.link.target) === false))
    findings.push({
      code: "profile-target-recovery",
      message:
        "Prepared recovery belongs to another context. Settle that recovery before applying a profile here.",
    });
  for (const root of targets) {
    const descriptors = state.data.enabledAdapters.map((id) => agentAdapterDescriptor(id));
    const directories = descriptors.flatMap((adapter) =>
      [
        namespace._tag === "user" ? adapter.userSkillDirectory : adapter.projectSkillDirectory,
        namespace._tag === "user" ? adapter.userCommandDirectory : adapter.projectCommandDirectory,
      ]
        .filter((entry) => entry !== undefined)
        .map((entry) => path.join(root, ...entry)),
    );
    directories.push(
      ...[...relevantLinks, ...relevantJournal.map((entry) => entry.link)]
        .filter((link) => link.target.canonicalPath === root)
        .map((link) => path.dirname(link.destinationPath)),
      ...(namespace._tag === "project" ? [path.join(root, ".tack", "docs")] : []),
    );
    for (const directory of directories) {
      let parent = directory;
      while ((yield* fs.exists(parent)) === false && parent !== root) parent = path.dirname(parent);
      const resolved = yield* fs.realPath(parent);
      if (resolved !== root && resolved.startsWith(`${root}${path.sep}`) === false)
        findings.push({
          code: "profile-target-boundary",
          message: `${directory} resolves outside the authorized target to ${resolved}. Use an isolated destination; force cannot bypass this.`,
        });
    }
  }
  return { targets, existing, findings };
});

/** Reports unavailable target paths as preflight findings for both source and bundle application. */
export const inspectProfileTarget = (
  state: State,
  options: StateOptions,
  request: ProfileTargetRequest,
) =>
  observeProfileTarget(state, options, request).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        targets: [] as ReadonlyArray<string>,
        existing: [] as ReadonlyArray<string>,
        findings: [{ code: "profile-target-unavailable", message: error.message }],
      }),
    ),
  );

/** Replaces only the explicitly authorized namespace's daily intent with retained fixed intent. */
export const withProfileApplication = (state: State, application: ProfileApplication): State => ({
  ...state,
  data: {
    ...state.data,
    userChoices: application.namespace._tag === "user" ? [] : state.data.userChoices,
    projects: state.data.projects.map((project) =>
      application.namespace._tag === "project" && project.name === application.namespace.projectName
        ? { ...project, choices: [], docs: { attachments: [] } }
        : project,
    ),
    profileApplications: [
      ...(state.data.profileApplications ?? []).filter(
        (entry) =>
          choiceNamespaceIdentity(entry.namespace) !==
          choiceNamespaceIdentity(application.namespace),
      ),
      application,
    ],
  },
});
