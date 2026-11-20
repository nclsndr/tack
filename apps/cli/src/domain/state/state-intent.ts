import type { DocsProject } from "../docs/docs-schema.ts";
import { docsResourceIdentity } from "../docs/docs-schema.ts";
import type { SkillChoice } from "../choices/choice-schema.ts";
import type { State } from "./state-schema.ts";

/** Projects own their decisions; this view supplies namespaces to selection and reports. */
export const allSkillChoices = (state: State): SkillChoice[] => [
  ...state.data.userChoices.map((choice) => ({
    ...choice,
    namespace: { _tag: "user" as const },
  })),
  ...state.data.projects.flatMap((project) =>
    (project.choices ?? []).map((choice) => ({
      ...choice,
      namespace: { _tag: "project" as const, projectName: project.name },
    })),
  ),
];

/** One effective docs view for reading, writing-target lookup and mounting, including fixed inventory. */
export const docsSettingsFor = (state: State, projectName: string): DocsProject | undefined => {
  const project = state.data.projects.find((entry) => entry.name === projectName);
  if (project === undefined) return undefined;
  const fixed = state.data.profileApplications?.find(
    (application) =>
      application.namespace["_tag"] === "project" &&
      application.namespace.projectName === projectName,
  );
  const attachments =
    fixed === undefined
      ? project.docs?.attachments
      : fixed.inventory
          .filter((address) => address.kind === "docs")
          .map((address) => ({
            name: address.name,
            sourceRegistrationId: address.sourceRegistrationId,
          }));
  if (attachments === undefined) return undefined;
  const writing = project.docs?.attachments.find(
    (attachment) => attachment.writingDefault === true,
  );
  return {
    projectName,
    attachments: attachments.map(({ sourceRegistrationId, name }) => ({
      sourceRegistrationId,
      name,
    })),
    ...(project.docs?.destination === undefined ? {} : { destination: project.docs?.destination }),
    ...(writing === undefined
      ? {}
      : {
          defaultWritingResource: {
            sourceRegistrationId: writing.sourceRegistrationId,
            name: writing.name,
          },
        }),
  };
};

/** Lists retained docs settings in project order for state inspection. */
export const allDocsSettings = (state: State): DocsProject[] =>
  state.data.projects.flatMap((project) => {
    const settings = docsSettingsFor(state, project.name);
    return settings === undefined ? [] : [settings];
  });

/** Updates one project's docs intent without a separate collection to retire later. */
export const withDocsSettings = (state: State, settings: DocsProject): State => ({
  ...state,
  data: {
    ...state.data,
    projects: state.data.projects.map((project) =>
      project.name === settings.projectName
        ? {
            ...project,
            docs: {
              attachments: settings.attachments.map((resource) => ({
                ...resource,
                ...(settings.defaultWritingResource !== undefined &&
                docsResourceIdentity(resource) ===
                  docsResourceIdentity(settings.defaultWritingResource)
                  ? { writingDefault: true as const }
                  : {}),
              })),
              ...(settings.destination === undefined ? {} : { destination: settings.destination }),
            },
          }
        : project,
    ),
  },
});
