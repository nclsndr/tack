import { reportDocsManagedLink } from "../../src/domain/docs/docs-schema.ts";
import type { DocsLinkPlan, DocsManagedLink } from "../../src/domain/docs/docs-schema.ts";
import { crashApplyRegistrationId } from "./crash-apply-catalog.ts";

/** The project every crash-mixed docs mount belongs to, below `home`. */
export const mixedProjectRoot = (home: string) => `${home}/project`;

/** The directory of the `index`-th docs source below `sourcesDirectory`. */
export const mixedDocsSource = (sourcesDirectory: string, index: number) =>
  `${sourcesDirectory}/docs/doc-${String(index).padStart(3, "0")}`;

/** The docs mounts of `count` docs resources, one per source directory `mixedDocsSource` names. */
export const mixedDocsMounts = (
  home: string,
  sourcesDirectory: string,
  count: number,
): ReadonlyArray<DocsManagedLink> =>
  Array.from({ length: count }, (_, index): DocsManagedLink => {
    const name = `doc-${String(index).padStart(3, "0")}`;
    const root = mixedProjectRoot(home);
    return {
      projectName: "workspace",
      root,
      resource: { sourceRegistrationId: crashApplyRegistrationId, name },
      destinationPath: `${root}/.tack/docs/${crashApplyRegistrationId}/${name}`,
      sourceDirectoryPath: mixedDocsSource(sourcesDirectory, index),
    };
  });

/** A docs plan that creates each of the mounts that `missing` accepts. */
export const mixedDocsPlan = (
  mounts: ReadonlyArray<DocsManagedLink>,
  missing: (mount: DocsManagedLink) => boolean = () => true,
): DocsLinkPlan => ({
  actions: mounts.map((mount) => ({
    action: missing(mount) ? ("create" as const) : ("keep" as const),
    evidence: reportDocsManagedLink(mount),
  })),
  complete: true,
  issues: [],
  kind: "docs-reconciliation-plan",
});
