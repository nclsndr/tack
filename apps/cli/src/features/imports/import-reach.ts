import { type Namespace } from "../../domain/choices/choice-schema.ts";
import { profileApplicationFor } from "../../domain/profiles/profile-application.ts";
import {
  resolveInitialSelection,
  type InitialSelectionDecision,
} from "../../domain/choices/selection.ts";
import { allChoices } from "../../domain/state/state-intent.ts";
import {
  catalogSelectableEntries,
  resourceAddressIdentity,
  type Catalog,
  type SkillCatalogEntry,
} from "../../domain/sources/catalog-schema.ts";
import { sourceQualifier } from "../sources/resource-reference.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { skillFolderPath, type ImportDestination } from "./import-destination.ts";
import type { ImportCandidate, ImportReach } from "../../domain/imports/import-schema.ts";

const namespaceText = (namespace: Namespace) =>
  namespace._tag === "user" ? "user" : `project ${namespace.projectName}`;

const reasonText = (
  namespace: Namespace,
  reason: Extract<InitialSelectionDecision, { readonly _tag: "not-selected" }>["reason"],
) =>
  reason === "exclude"
    ? "pick exclude"
    : reason === "opt-in"
      ? namespace._tag === "user"
        ? "user activation is opt-in"
        : "activation is opt-in"
      : reason === "project-incompatible"
        ? "metadata.tack.projects does not name this project"
        : reason === "superseded"
          ? "another source's skill of this name is included"
          : "an older pick without a source matches several skills";

/**
 * The skill as the destination's catalog will hold it after the copy: activation, user activation
 * and project list from the upstream Tack metadata, the defaults of a skill without any.
 */
const hypotheticalEntry = (
  destination: ImportDestination,
  candidate: ImportCandidate,
): SkillCatalogEntry => {
  const directoryPath = `${destination.root}/${skillFolderPath(destination.folder, candidate.name)}`;
  return {
    activation: candidate.upstreamTack?.activation ?? "default",
    userActivation: candidate.upstreamTack?.userActivation ?? "opt-in",
    address: {
      kind: "skill",
      name: candidate.name,
      sourceRegistrationId: destination.inspection.registration.id,
    },
    dependencies: [],
    description: candidate.description ?? candidate.name,
    directoryPath,
    frontmatter: {},
    projects: candidate.upstreamTack?.projects ?? [],
    skillFilePath: `${directoryPath}/SKILL.md`,
    sourcePath: destination.root,
    sourceRegistrationId: destination.inspection.registration.id,
  };
};

/**
 * Where one imported skill will be delivered at the next `sync`, computed offline from the state as
 * if the skill were already in the catalog. It runs the selection `sync` runs, so the projects,
 * user decision, collisions and ambiguous picks agree with `sync --all` after the copy. It is
 * information and never changes a verdict.
 */
export const computeReach = (input: {
  readonly state: State;
  readonly catalog: Pick<Catalog, "entries" | "quarantined"> & Partial<Pick<Catalog, "sources">>;
  readonly destination: ImportDestination;
  readonly candidate: ImportCandidate;
}): ImportReach => {
  const { state, catalog, destination, candidate } = input;
  const entry = hypotheticalEntry(destination, candidate);
  const entries = catalogSelectableEntries({ entries: [...catalog.entries, entry] });
  const choices = allChoices(state);
  const noAdapters = state.data.enabledAdapters.length === 0;
  const namespaces: ReadonlyArray<Namespace> = [
    ...[...state.data.projects]
      .sort((left, right) => compareCodeUnits(left.name, right.name))
      .map((project): Namespace => ({ _tag: "project", projectName: project.name })),
    { _tag: "user" },
  ];
  const decided = namespaces.map((namespace) => {
    const selection = resolveInitialSelection({ choices, entries, namespace });
    const own = selection.decisions.find(
      (decision) =>
        decision.address.kind === "skill" &&
        decision.address.name === entry.address.name &&
        decision.address.sourceRegistrationId === entry.sourceRegistrationId,
    );
    const others = selection.decisions.filter(
      (decision) =>
        decision._tag === "selected" &&
        decision.address.kind === "skill" &&
        decision.address.name === entry.address.name &&
        decision.address.sourceRegistrationId !== entry.sourceRegistrationId,
    );
    const application = profileApplicationFor(state, namespace);
    const fixed =
      application === undefined ||
      application.inventory.some(
        (address) => resourceAddressIdentity(address) === resourceAddressIdentity(entry.address),
      )
        ? undefined
        : {
            profile: `${sourceQualifier(catalog, application.sourceRegistrationId)}:${application.profileName}`,
          };
    return { namespace, selection, own, others, application, fixed };
  });
  const delivery = (item: (typeof decided)[number]) => {
    const { own } = item;
    if (item.fixed !== undefined)
      return { receives: false, reason: `fixed by profile ${item.fixed.profile}` };
    // A fixed profile that retains this very address delivers it once the import restores it.
    if (item.application !== undefined)
      return noAdapters
        ? { receives: false, reason: "no agent adapter is enabled" }
        : { receives: true, reason: undefined };
    if (own === undefined) return { receives: false, reason: "not selected" };
    if (own._tag === "not-selected")
      return { receives: false, reason: reasonText(item.namespace, own.reason) };
    return noAdapters
      ? { receives: false, reason: "no agent adapter is enabled" }
      : { receives: true, reason: undefined };
  };
  const user = decided.find((item) => item.namespace._tag === "user");
  const userDelivery =
    user === undefined ? { receives: false, reason: "no user target" } : delivery(user);
  const declared = destination.inspection.dependsOn ?? [];
  const projects = decided.flatMap((item) => {
    const namespace = item.namespace;
    if (namespace._tag !== "project") return [];
    const roots =
      state.data.projects.find((project) => project.name === namespace.projectName)?.roots ?? [];
    return [{ ...item, projectName: namespace.projectName, roots }];
  });
  return {
    name: candidate.name,
    projects: projects
      .filter((item) => item.fixed === undefined)
      .map((item) => {
        const result = delivery(item);
        return {
          project: item.projectName,
          receives: result.receives,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        };
      }),
    fixedProfileProjects: projects.flatMap((item) =>
      item.fixed === undefined
        ? []
        : [
            {
              project: item.projectName,
              profile: item.fixed.profile,
              deliver: [
                ...["tack", "profile", "apply", item.fixed.profile, "--project", item.projectName],
                ...item.roots.flatMap((root) => ["--target-root", root]),
                "--force",
              ],
            },
          ],
    ),
    user: { receives: userDelivery.receives, reason: userDelivery.reason ?? "selected by default" },
    collisions: decided
      .filter((item) => item.application === undefined && item.own?._tag === "selected")
      .flatMap((item) =>
        item.others.map((other) => ({
          namespace: namespaceText(item.namespace),
          with: `${sourceQualifier(catalog, other.address.sourceRegistrationId)}:${other.address.name}`,
        })),
      ),
    undeclaredDependencies: (candidate.upstreamTack?.dependencies ?? [])
      .filter(
        (dependency) =>
          dependency.source !== undefined &&
          dependency.source !== destination.name &&
          dependency.source !== destination.inspection.registration.id &&
          declared.includes(dependency.source) === false,
      )
      .map((dependency) => `${dependency.source ?? ""}:${dependency.name}`),
  };
};
