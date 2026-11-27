import { profileControlledAddresses } from "./profile-policy.ts";
import { Effect, Schema } from "effect";
import { choiceNamespaceIdentity, type ChoiceNamespace } from "../choices/choice-schema.ts";
import {
  catalogSelectableEntries,
  isSelectableAddress,
  resourceAddressIdentity,
  type Catalog,
  type SelectableAddress,
} from "../sources/catalog-schema.ts";
import {
  resolveDependencyClosure,
  selectedDependencyAddresses,
  type DependencyResolution,
} from "../choices/dependency-resolution.ts";
import { resolveNamespaceSelection, type InitialSelection } from "../choices/selection.ts";
import { allSkillChoices } from "../state/state-intent.ts";
import type { ProfileApplication } from "../state/profile-application-schema.ts";
import type { State } from "../state/state-schema.ts";

/** Finds the fixed application that owns this selection context. */
export const profileApplicationFor = (state: Pick<State, "data">, namespace: ChoiceNamespace) =>
  state.data.profileApplications?.find(
    (entry) => choiceNamespaceIdentity(entry.namespace) === choiceNamespaceIdentity(namespace),
  );

/** Ordinary choice writes must never persist intent that fixed sync would ignore. */
export class FixedProfileError extends Schema.TaggedError<FixedProfileError>()(
  "FixedProfileError",
  { code: Schema.Literal("profile-fixed-context"), message: Schema.String },
) {}

/** Refuses daily selection edits in a retained fixed context. */
export const requireDefaultSelection = (state: State, namespace: ChoiceNamespace) =>
  profileApplicationFor(state, namespace) === undefined
    ? Effect.void
    : Effect.fail(
        new FixedProfileError({
          code: "profile-fixed-context",
          message:
            "This context has a fixed profile application. Choose a separate daily-selection context or explicitly reapply the profile.",
        }),
      );

/** Resolves retained identities without subscribing to the authored manifest or new defaults. */
const retainedProfileSelection = (
  application: ProfileApplication,
  catalog: Catalog,
  actualTargets?: ReadonlyArray<string>,
): {
  readonly selection: InitialSelection;
  readonly resolution: DependencyResolution;
  readonly issues: ReadonlyArray<string>;
} => {
  const selectable = (
    addresses: ProfileApplication["inventory"],
  ): ReadonlyArray<SelectableAddress> =>
    profileControlledAddresses(catalog, addresses).filter(isSelectableAddress);
  const decisions: InitialSelection["decisions"] = selectable(application.direct).map(
    (address) => ({ _tag: "selected", address, compatibility: "forced", reason: "include" }),
  );
  const selection: InitialSelection = {
    namespace: application.namespace,
    decisions,
    unresolvedChoices: [],
  };
  const closure = resolveDependencyClosure({
    entries: catalogSelectableEntries(catalog),
    sources: catalog.sources ?? [],
    quarantined: catalog.quarantined,
    initialSelection: selection,
    includeOptional: false,
  });
  const available = new Set(catalog.entries.map((entry) => resourceAddressIdentity(entry.address)));
  const missing = profileControlledAddresses(catalog, application.inventory).filter(
    (address) => available.has(resourceAddressIdentity(address)) === false,
  );
  const expected = new Set(
    selectable(application.inventory).map((address) => resourceAddressIdentity(address)),
  );
  const current = new Set(
    profileControlledAddresses(catalog, selectedDependencyAddresses(closure)).map((address) =>
      resourceAddressIdentity(address),
    ),
  );
  const changed =
    expected.size !== current.size || [...expected].some((key) => current.has(key) === false);
  return {
    selection,
    resolution: {
      groups: selectable(application.inventory).map((address) => ({
        _tag: "selected",
        members: [address],
      })),
      optionalSkips: [],
      requestBlockers: [],
    },
    issues: [
      ...(actualTargets !== undefined &&
      (actualTargets.length !== application.targets.length ||
        application.targets.some((root) => !actualTargets.includes(root)))
        ? ["The complete target boundary changed. Explicitly reapply with every root before sync."]
        : []),
      ...missing.map(
        (address) =>
          `Retained ${address.kind} ${address.sourceRegistrationId}:${address.name} is unavailable; restore its source/member before retry.`,
      ),
      ...(changed
        ? [
            "Required dependency inventory changed or is blocked. Explicitly reapply the profile; sync preserves the retained inventory.",
          ]
        : []),
    ],
  };
};

/** Shares ordinary versus retained selection policy between sync and status. */
export const resolveContextSelection = (
  state: State,
  catalog: Catalog,
  namespace: ChoiceNamespace,
  includeOptional: boolean,
  actualTargets?: ReadonlyArray<string>,
) => {
  const application = profileApplicationFor(state, namespace);
  return application === undefined
    ? {
        ...resolveNamespaceSelection({
          catalog,
          namespace,
          includeOptional,
          choices: allSkillChoices(state),
        }),
        issues: [],
        application,
      }
    : { ...retainedProfileSelection(application, catalog, actualTargets), application };
};
