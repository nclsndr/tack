import {
  requireDefaultSelection,
  type FixedProfileError,
} from "../../domain/profiles/profile-application.ts";
import { Effect, Match, Schema } from "effect";
import {
  ChoiceNamespaceSchema,
  choiceNamespaceIdentity,
  SkillChoiceSchema,
  skillChoiceIdentity,
  type ChoiceNamespace,
  type SkillChoice,
} from "../../domain/choices/choice-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { allSkillChoices } from "../../domain/state/state-intent.ts";
import { projectLifecycle } from "../../domain/projects/project-schema.ts";
import {
  isSelectableAddress,
  resourceAddressIdentity,
  SelectableAddressSchema,
  type ResourceAddress,
  type SelectableAddress,
} from "../../domain/sources/catalog-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";
import type { StateCheckpointWriter, StateMutation } from "../../services/state-store.ts";

/** Reports a choice operation for a project namespace that is not registered. */
export class ChoiceProjectNotFoundError extends Schema.TaggedError<ChoiceProjectNotFoundError>()(
  "ChoiceProjectNotFoundError",
  {
    code: Schema.Literal("choice-project-not-found"),
    projectName: Schema.String,
  },
) {}

/** Reports a choice mutation against a project retained only for removal cleanup. */
export class ChoiceProjectRemovingError extends Schema.TaggedError<ChoiceProjectRemovingError>()(
  "ChoiceProjectRemovingError",
  {
    code: Schema.Literal("choice-project-removing"),
    projectName: Schema.String,
  },
) {}

/** The `pick include` and `pick exclude` payload: the choice now held and whether it changed. */
export const ChoiceChangePayloadSchema = Schema.Struct({
  kind: Schema.Literal("choice-change"),
  changed: Schema.Boolean,
  choice: SkillChoiceSchema,
});

/** The result of persisting or confirming one exact choice. */
export type SetSkillChoiceResult = Omit<typeof ChoiceChangePayloadSchema.Type, "kind">;

/** The `pick remove` payload: the choice's identity and whether one was removed. */
export const ChoiceRemovalPayloadSchema = Schema.Struct({
  kind: Schema.Literal("choice-removal"),
  address: SelectableAddressSchema,
  namespace: ChoiceNamespaceSchema,
  removed: Schema.Boolean,
});

/** The result of removing or confirming the absence of one exact choice. */
export type RemoveSkillChoiceResult = Omit<typeof ChoiceRemovalPayloadSchema.Type, "kind">;

/**
 * The details of a `choice-address-not-in-catalog` warning: the chosen address and the catalog
 * addresses closest to it.
 */
export const ChoiceAddressCandidatesSchema = Schema.Struct({
  candidates: Schema.Array(SelectableAddressSchema),
  subject: Schema.Struct({ address: SelectableAddressSchema }),
});

/** The details of a `choice-address-not-in-catalog` warning. */
export type ChoiceAddressCandidates = typeof ChoiceAddressCandidatesSchema.Type;

/** The exact identity needed to remove one persisted choice. */
export type RemoveSkillChoiceOptions = {
  readonly address: SelectableAddress;
  readonly namespace: ChoiceNamespace;
};

const choicesFrom = (state: State): ReadonlyArray<SkillChoice> => allSkillChoices(state);

/** Replaces one namespace's persisted choices in a state snapshot without persisting it. */
export const withChoice = (
  state: State,
  namespace: ChoiceNamespace,
  choices: ReadonlyArray<SkillChoice>,
): State =>
  namespace._tag === "user"
    ? {
        ...state,
        data: {
          ...state.data,
          userChoices: choices
            .filter((choice) => choice.namespace._tag === "user")
            .map(({ address, decision }) => ({ address, decision })),
        },
      }
    : {
        ...state,
        data: {
          ...state.data,
          projects: state.data.projects.map((project) =>
            project.name === namespace.projectName
              ? {
                  ...project,
                  choices: choices
                    .filter(
                      (choice) =>
                        choice.namespace._tag === "project" &&
                        choice.namespace.projectName === project.name,
                    )
                    .map(({ address, decision }) => ({ address, decision })),
                }
              : project,
          ),
        },
      };

/** Orders choices by namespace, then by address, the way state lists them. */
const sortChoices = (choices: ReadonlyArray<SkillChoice>) =>
  [...choices].sort((left, right) =>
    compareCodeUnits(skillChoiceIdentity(left), skillChoiceIdentity(right)),
  );

/** Fails unless the namespace is the user's or a registered project that is not being removed. */
export const requireChoiceNamespace = (state: State, namespace: ChoiceNamespace) =>
  Match.value(namespace).pipe(
    Match.tag("user", () => Effect.void),
    Match.tag("project", ({ projectName }) =>
      Effect.gen(function* () {
        const project = state.data.projects.find((candidate) => candidate.name === projectName);
        if (project === undefined) {
          return yield* new ChoiceProjectNotFoundError({
            code: "choice-project-not-found",
            projectName,
          });
        }
        if (projectLifecycle(project) === "removing") {
          return yield* new ChoiceProjectRemovingError({
            code: "choice-project-removing",
            projectName,
          });
        }
        return undefined;
      }),
    ),
    Match.exhaustive,
  );

/** Persists one exact choice without consulting the live resource catalog. */
export const setSkillChoice = Effect.fn("choices.setSkillChoice")(function* (
  writer: StateCheckpointWriter,
  choice: SkillChoice,
) {
  return yield* writer.checkpoint((state) =>
    Effect.gen(function* (): Effect.fn.Return<
      StateMutation<SetSkillChoiceResult>,
      ChoiceProjectNotFoundError | ChoiceProjectRemovingError | FixedProfileError
    > {
      yield* requireChoiceNamespace(state, choice.namespace);
      yield* requireDefaultSelection(state, choice.namespace);
      const choices = choicesFrom(state);
      const identity = skillChoiceIdentity(choice);
      const existing = choices.find((candidate) => skillChoiceIdentity(candidate) === identity);

      if (existing?.decision === choice.decision) {
        return { state, value: { changed: false, choice: existing } };
      }

      const nextChoices = sortChoices([
        ...choices.filter((candidate) => skillChoiceIdentity(candidate) !== identity),
        choice,
      ]);
      return {
        state: withChoice(state, choice.namespace, nextChoices),
        value: { changed: true, choice },
      };
    }),
  );
});

/** Levenshtein distance between two names, for did-you-mean candidates. */
const editDistance = (left: string, right: string) => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(
        Math.min(
          (previous[rightIndex + 1] ?? 0) + 1,
          (current[rightIndex] ?? 0) + 1,
          (previous[rightIndex] ?? 0) + (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
};

const maximumCandidates = 5;

/**
 * Checks a chosen address against the catalog. Returns `undefined` when the catalog has it, and
 * otherwise the addresses the operator probably meant: the same name from another source or kind,
 * or the same kind with a name at most two edits away, nearest first.
 */
export const catalogAddressCandidates = (
  catalog: { readonly entries: ReadonlyArray<{ readonly address: ResourceAddress }> },
  address: SelectableAddress,
): ReadonlyArray<SelectableAddress> | undefined => {
  // Only skills, commands and contexts can be chosen, so only they are candidates.
  const addresses = catalog.entries.map((entry) => entry.address).filter(isSelectableAddress);
  const identity = resourceAddressIdentity(address);
  if (addresses.some((candidate) => resourceAddressIdentity(candidate) === identity)) {
    return undefined;
  }
  return addresses
    .map((candidate) => ({
      candidate,
      distance:
        candidate.name === address.name
          ? 0
          : candidate.kind === address.kind
            ? editDistance(candidate.name, address.name)
            : Number.POSITIVE_INFINITY,
    }))
    .filter(({ distance }) => distance <= 2)
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        compareCodeUnits(
          resourceAddressIdentity(left.candidate),
          resourceAddressIdentity(right.candidate),
        ),
    )
    .slice(0, maximumCandidates)
    .map(({ candidate }) => candidate);
};

/** Removes one exact choice so declaration-driven behavior applies again. */
export const removeSkillChoice = Effect.fn("choices.removeSkillChoice")(function* (
  writer: StateCheckpointWriter,
  remove: RemoveSkillChoiceOptions,
) {
  return yield* writer.checkpoint((state) =>
    Effect.gen(function* (): Effect.fn.Return<
      StateMutation<RemoveSkillChoiceResult>,
      ChoiceProjectNotFoundError | ChoiceProjectRemovingError | FixedProfileError
    > {
      yield* requireChoiceNamespace(state, remove.namespace);
      yield* requireDefaultSelection(state, remove.namespace);
      const identity = skillChoiceIdentity(remove);
      const choices = choicesFrom(state);
      const retained = choices.filter((candidate) => skillChoiceIdentity(candidate) !== identity);

      if (retained.length === choices.length) {
        return { state, value: { ...remove, removed: false } };
      }

      return {
        state: withChoice(state, remove.namespace, sortChoices(retained)),
        value: { ...remove, removed: true },
      };
    }),
  );
});

/** The `pick` payload: the persisted choices, in the order `listSkillChoices` returns them. */
export const ChoiceListPayloadSchema = Schema.Struct({
  kind: Schema.Literal("choices"),
  choices: Schema.Array(SkillChoiceSchema),
});

/** Lists persisted choices in deterministic order, optionally narrowed to one namespace. */
export const listSkillChoices = Effect.fn("choices.listSkillChoices")(function* (
  state: State,
  namespace?: ChoiceNamespace,
) {
  // Listing never mutates, so a project being removed still lists its retained choices.
  if (
    namespace?._tag === "project" &&
    !state.data.projects.some((project) => project.name === namespace.projectName)
  ) {
    return yield* new ChoiceProjectNotFoundError({
      code: "choice-project-not-found",
      projectName: namespace.projectName,
    });
  }
  const choices = choicesFrom(state);

  return sortChoices(
    namespace === undefined
      ? choices
      : choices.filter(
          (choice) =>
            choiceNamespaceIdentity(choice.namespace) === choiceNamespaceIdentity(namespace),
        ),
  );
});
