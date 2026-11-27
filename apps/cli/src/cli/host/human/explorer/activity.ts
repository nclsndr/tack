import { isBuiltinSkill } from "../../../../domain/choices/builtin.ts";
import {
  choiceNamespaceIdentity,
  type Namespace,
} from "../../../../domain/choices/choice-schema.ts";
import type { InitialSelectionDecision } from "../../../../domain/choices/selection.ts";
import { docsResourceIdentity } from "../../../../domain/docs/docs-schema.ts";
import { resolveContextSelection } from "../../../../domain/profiles/profile-application.ts";
import {
  catalogSelectableEntries,
  resourceAddressIdentity,
  type Catalog,
  type ResourceAddress,
} from "../../../../domain/sources/catalog-schema.ts";
import { docsSettingsFor } from "../../../../domain/state/state-intent.ts";
import type { State } from "../../../../domain/state/state-schema.ts";
import { sourceQualifier } from "../../../../features/sources/resource-reference.ts";

/** Why a resource is or is not delivered to one destination. */
const activityReasons = [
  "default",
  "included",
  "dependency",
  "blocked",
  "excluded",
  "opt-in",
  "other project",
  "superseded",
  "member",
  "required",
  "not a member",
  "locked",
  "attached",
  "detached",
] as const;

/** Whether a resource is delivered to one destination, and why. */
export type ExplorerActivity = {
  readonly active: boolean;
  readonly reason: (typeof activityReasons)[number];
  /**
   * Set on a project when the user scope delivers the resource: every project's agent also loads
   * the user's resources, and sync does not link one the project selects too.
   */
  readonly viaUser?: true;
};

/** A published profile and the inventory its file resolves to. */
export type PublishedProfile = {
  readonly sourcePath: string;
  readonly sourceRegistrationId: string;
  readonly name: string;
  readonly direct: ReadonlyArray<ResourceAddress>;
  readonly required: ReadonlyArray<ResourceAddress>;
};

/** What a state line describes: the user scope, a project selection or a published profile. */
export type ActivityScope =
  | { readonly _tag: "user" }
  | { readonly _tag: "project"; readonly projectName: string }
  | { readonly _tag: "profile"; readonly sourcePath: string; readonly profileName: string };

/** One destination's activity for every resource it decides, keyed by address identity. */
export type DestinationActivity = {
  readonly scope: ActivityScope;
  /** `user`, the project name, or the profile as `source/name`. */
  readonly label: string;
  /** The profile, as `source/name`, that fixes this user or project selection. */
  readonly fixedBy?: string;
  /** For a profile: the user or projects it is applied to. */
  readonly appliedTo?: ReadonlyArray<string>;
  readonly activities: ReadonlyMap<string, ExplorerActivity>;
};

/** Identifies a scope, so the edited destination can be found among the state lines. */
export const scopeKey = (scope: ActivityScope): string =>
  scope._tag === "profile"
    ? `profile:${scope.sourcePath}\u0000${scope.profileName}`
    : choiceNamespaceIdentity(scope);

const notSelected = {
  exclude: "excluded",
  "opt-in": "opt-in",
  "project-incompatible": "other project",
  superseded: "superseded",
} as const satisfies Record<
  Extract<InitialSelectionDecision, { _tag: "not-selected" }>["reason"],
  ExplorerActivity["reason"]
>;

/** The marker a row shows for an activity: delivered, not delivered, or blocked. */
const activityGlyph = (activity: ExplorerActivity): string =>
  activity.reason === "blocked" ? "✗" : activity.active ? "●" : "○";

/** The glyph and reason, as the details panel prints them. */
export const activityText = (activity: ExplorerActivity): string =>
  `${activityGlyph(activity)} ${activity.reason}`;

/** The glyph and reason as a row prints them, noting a resource the user scope brings in. */
export const rowActivityText = (activity: ExplorerActivity): string =>
  `${activityText(activity)}${activity.viaUser === true ? " · via user" : ""}`;

/** Names a profile by its source label and name, such as `kit/ci`. */
export const profileLabel = (catalog: Catalog, sourceRegistrationId: string, name: string) =>
  `${sourceQualifier(catalog, sourceRegistrationId)}/${name}`;

/**
 * Resolves what one user or project selection delivers with the selection `sync` and `status`
 * share, then names the reason for each resource. A fixed profile names membership instead of
 * picks and defaults.
 */
const selectionActivity = (
  state: State,
  catalog: Catalog,
  namespace: Namespace,
): DestinationActivity => {
  const { selection, resolution, application } = resolveContextSelection(
    state,
    catalog,
    namespace,
    false,
  );
  const decisions = new Map(
    selection.decisions.map((decision) => [resourceAddressIdentity(decision.address), decision]),
  );
  const membersOf = (tag: "selected" | "blocked") =>
    new Set(
      resolution.groups
        .filter((group) => group._tag === tag)
        .flatMap((group) => group.members.map((member) => resourceAddressIdentity(member))),
    );
  const selected = membersOf("selected");
  const blocked = membersOf("blocked");
  const fixed = application !== undefined;
  const resources = catalogSelectableEntries(catalog).map((entry): [string, ExplorerActivity] => {
    const identity = resourceAddressIdentity(entry.address);
    const active = selected.has(identity);
    const decision = decisions.get(identity);
    const reason: ExplorerActivity["reason"] = isBuiltinSkill(entry)
      ? "locked"
      : blocked.has(identity) && active === false
        ? "blocked"
        : fixed
          ? active
            ? decision === undefined
              ? "required"
              : "member"
            : "not a member"
          : decision === undefined
            ? "dependency"
            : decision._tag === "selected"
              ? decision.reason === "include"
                ? "included"
                : "default"
              : active
                ? "dependency"
                : notSelected[decision.reason];
    return [identity, { active, reason }];
  });
  const attachments =
    namespace._tag === "project"
      ? new Set(
          (docsSettingsFor(state, namespace.projectName)?.attachments ?? []).map((resource) =>
            docsResourceIdentity(resource),
          ),
        )
      : undefined;
  const docs =
    attachments === undefined
      ? []
      : catalog.entries.flatMap((entry): ReadonlyArray<[string, ExplorerActivity]> => {
          if (entry.address.kind !== "docs") return [];
          const attached = attachments.has(
            docsResourceIdentity({
              sourceRegistrationId: entry.address.sourceRegistrationId,
              name: entry.address.name,
            }),
          );
          return [
            [
              resourceAddressIdentity(entry.address),
              { active: attached, reason: attached ? "attached" : "detached" },
            ],
          ];
        });
  return {
    scope: namespace,
    label: namespace._tag === "user" ? "user" : namespace.projectName,
    ...(application === undefined
      ? {}
      : {
          fixedBy: profileLabel(catalog, application.sourceRegistrationId, application.profileName),
        }),
    activities: new Map([...resources, ...docs]),
  };
};

/** What a published profile holds: its members, what they require, and nothing else. */
const profileActivity = (
  state: State,
  catalog: Catalog,
  profile: PublishedProfile,
): DestinationActivity => {
  const identities = (addresses: ReadonlyArray<ResourceAddress>) =>
    new Set(addresses.map((address) => resourceAddressIdentity(address)));
  const direct = identities(profile.direct);
  const required = identities(profile.required);
  return {
    scope: { _tag: "profile", sourcePath: profile.sourcePath, profileName: profile.name },
    label: profileLabel(catalog, profile.sourceRegistrationId, profile.name),
    appliedTo: (state.data.profileApplications ?? [])
      .filter(
        (application) =>
          application.sourceRegistrationId === profile.sourceRegistrationId &&
          application.profileName === profile.name,
      )
      .map((application) =>
        application.namespace._tag === "user" ? "user" : application.namespace.projectName,
      ),
    activities: new Map(
      catalogSelectableEntries(catalog).map((entry): [string, ExplorerActivity] => {
        const identity = resourceAddressIdentity(entry.address);
        return [
          identity,
          isBuiltinSkill(entry)
            ? { active: false, reason: "locked" }
            : direct.has(identity)
              ? { active: true, reason: "member" }
              : required.has(identity)
                ? { active: true, reason: "required" }
                : { active: false, reason: "not a member" },
        ];
      }),
    ),
  };
};

/**
 * Marks what a project gets from the user scope: what it does not select, and what it selects too,
 * which sync leaves to the user's link.
 */
const withUserReach = (
  project: DestinationActivity,
  user: DestinationActivity,
): DestinationActivity => ({
  ...project,
  activities: new Map(
    [...project.activities].map(([identity, activity]): [string, ExplorerActivity] => [
      identity,
      user.activities.get(identity)?.active === true ? { ...activity, viaUser: true } : activity,
    ]),
  ),
});

/**
 * Every state line in display order: the user scope, each registered project in state order, then
 * each published profile.
 */
export const explorerActivity = (
  state: State,
  catalog: Catalog,
  profiles: ReadonlyArray<PublishedProfile>,
): ReadonlyArray<DestinationActivity> => {
  const user = selectionActivity(state, catalog, { _tag: "user" });
  return [
    user,
    ...state.data.projects.map((project) =>
      withUserReach(
        selectionActivity(state, catalog, { _tag: "project", projectName: project.name }),
        user,
      ),
    ),
    ...profiles.map((profile) => profileActivity(state, catalog, profile)),
  ];
};

/** The activity of one resource in one destination, when that destination decides it. */
export const activityIn = (
  destination: DestinationActivity,
  address: ResourceAddress,
): ExplorerActivity | undefined => destination.activities.get(resourceAddressIdentity(address));
