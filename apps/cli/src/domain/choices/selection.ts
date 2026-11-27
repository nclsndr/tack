import { Match, Schema } from "effect";
import { resolveDependencyClosure, type DependencyResolution } from "./dependency-resolution.ts";
import {
  NamespaceSchema,
  ChoiceSchema,
  choiceNamespaceIdentity,
  kindAndNameKey,
  type Namespace,
  type Choice,
} from "./choice-schema.ts";
import { compareCodeUnits } from "../identity/ordering.ts";
import {
  SelectableAddressSchema,
  SkillActivationSchema,
  catalogSelectableEntries,
  resourceAddressIdentity,
  type Catalog,
  type SelectableCatalogEntry,
} from "../sources/catalog-schema.ts";

/** How project compatibility contributed to one initial selection decision. */
const InitialSelectionCompatibilitySchema = Schema.Literals([
  "compatible",
  "forced",
  "incompatible",
  "not-applicable",
]);

/**
 * One selected or omitted catalog resource before dependency closure. The decision names the
 * resource by address; the catalog it was decided from holds the resource itself.
 */
const InitialSelectionDecisionSchema = Schema.Union([
  Schema.TaggedStruct("selected", {
    address: SelectableAddressSchema,
    compatibility: Schema.Literals(["compatible", "forced", "not-applicable"]),
    reason: Schema.Literals(["default", "include"]),
  }),
  Schema.TaggedStruct("not-selected", {
    address: SelectableAddressSchema,
    compatibility: Schema.Literals(["compatible", "incompatible", "not-applicable"]),
    reason: Schema.Literals(["exclude", "opt-in", "project-incompatible", "superseded"]),
  }),
]);

/** The complete deterministic initial decision set for one namespace. */
export const InitialSelectionSchema = Schema.Struct({
  decisions: Schema.Array(InitialSelectionDecisionSchema),
  namespace: NamespaceSchema,
  unresolvedChoices: Schema.Array(ChoiceSchema),
});

/** One initial selection decision. */
export type InitialSelectionDecision = typeof InitialSelectionDecisionSchema.Type;

/** The initial selection result before dependencies are resolved. */
export type InitialSelection = typeof InitialSelectionSchema.Type;

/** Inputs to initial selection resolution. */
export type ResolveInitialSelectionInput = {
  readonly choices: ReadonlyArray<Choice>;
  readonly entries: ReadonlyArray<SelectableCatalogEntry>;
  readonly namespace: Namespace;
};

type Compatibility = typeof InitialSelectionCompatibilitySchema.Type;
type ObservedCompatibility = Exclude<Compatibility, "forced">;

const compatibilityFor = (
  namespace: Namespace,
  entry: SelectableCatalogEntry,
): ObservedCompatibility =>
  !("projects" in entry)
    ? "not-applicable"
    : Match.value(namespace).pipe(
        Match.tag("user", () => "not-applicable" as const),
        Match.tag("project", ({ projectName }) =>
          entry.projects.length === 0 || entry.projects.includes(projectName)
            ? ("compatible" as const)
            : ("incompatible" as const),
        ),
        Match.exhaustive,
      );

const decisionFor = (
  namespace: Namespace,
  entry: SelectableCatalogEntry,
  choice: Choice | undefined,
  compatibility: ObservedCompatibility,
  nameIncluded: boolean,
): InitialSelectionDecision => {
  if (choice?.decision === "exclude") {
    return {
      _tag: "not-selected",
      compatibility,
      address: entry.address,
      reason: "exclude",
    };
  }

  if (choice?.decision === "include") {
    return {
      _tag: "selected",
      compatibility: compatibility === "incompatible" ? "forced" : compatibility,
      address: entry.address,
      reason: "include",
    };
  }

  if (entry.origin === "bundle" || !("activation" in entry)) {
    return {
      _tag: "not-selected",
      address: entry.address,
      compatibility: "not-applicable",
      reason: "opt-in",
    };
  }

  const activation = activationIn(entry, namespace._tag);
  if (activation === "opt-in") {
    return {
      _tag: "not-selected",
      compatibility,
      address: entry.address,
      reason: "opt-in",
    };
  }

  if (compatibility === "incompatible") {
    return {
      _tag: "not-selected",
      compatibility,
      address: entry.address,
      reason: "project-incompatible",
    };
  }

  // An explicit include wins over a same-name twin that is only selected by default, so choosing
  // one candidate resolves a name clash without an exclude. Two explicit includes of one name both
  // stay selected and keep colliding, because the operator asked for both.
  if (nameIncluded === true) {
    return {
      _tag: "not-selected",
      compatibility,
      address: entry.address,
      reason: "superseded",
    };
  }

  return { _tag: "selected", address: entry.address, compatibility, reason: "default" };
};

/** Resolves declaration behavior and exact choices for one independent namespace. */
export const resolveInitialSelection = ({
  choices,
  entries,
  namespace,
}: ResolveInitialSelectionInput): InitialSelection => {
  const namespaceIdentity = choiceNamespaceIdentity(namespace);
  const namespaceChoices = choices
    .filter((choice) => choiceNamespaceIdentity(choice.namespace) === namespaceIdentity)
    .sort((left, right) =>
      compareCodeUnits(
        resourceAddressIdentity(left.address),
        resourceAddressIdentity(right.address),
      ),
    );
  // Every choice is exact: it names one resource by its source, kind and name.
  const choicesByAddress = new Map(
    namespaceChoices.map((choice) => [resourceAddressIdentity(choice.address), choice]),
  );
  const sortedEntries = [...entries].sort((left, right) =>
    compareCodeUnits(resourceAddressIdentity(left.address), resourceAddressIdentity(right.address)),
  );
  // An explicit include of a catalog resource claims its kind and name against default twins.
  const includedNames = new Set(
    sortedEntries.flatMap((entry) =>
      choicesByAddress.get(resourceAddressIdentity(entry.address))?.decision === "include"
        ? [kindAndNameKey(entry.address)]
        : [],
    ),
  );
  const catalogAddresses = new Set(
    sortedEntries.map((entry) => resourceAddressIdentity(entry.address)),
  );

  return {
    decisions: sortedEntries.map((entry) =>
      decisionFor(
        namespace,
        entry,
        choicesByAddress.get(resourceAddressIdentity(entry.address)),
        compatibilityFor(namespace, entry),
        includedNames.has(kindAndNameKey(entry.address)),
      ),
    ),
    namespace,
    unresolvedChoices: namespaceChoices.filter(
      (choice) => catalogAddresses.has(resourceAddressIdentity(choice.address)) === false,
    ),
  };
};

/** Inputs to the one selection pipeline shared by reconciliation and status. */
export type ResolveNamespaceSelectionInput = {
  readonly catalog: Pick<Catalog, "entries" | "quarantined"> & Partial<Pick<Catalog, "sources">>;
  readonly choices: ReadonlyArray<Choice>;
  readonly includeOptional: boolean;
  readonly namespace: Namespace;
};

/** One namespace's initial decisions and the dependency closure derived from them. */
export type NamespaceSelection = {
  readonly resolution: DependencyResolution;
  readonly selection: InitialSelection;
};

/**
 * The activation a resource declares for one kind of namespace: `activation` for a project, and
 * `user-activation` for the user, which is opt-in when the resource does not set it.
 */
export const activationIn = (
  entry: {
    readonly activation: typeof SkillActivationSchema.Type;
    readonly userActivation?: typeof SkillActivationSchema.Type;
  },
  scope: Namespace["_tag"],
): typeof SkillActivationSchema.Type =>
  scope === "user" ? (entry.userActivation ?? "opt-in") : entry.activation;

/** Selects one namespace's resources: initial choices and activation, then dependency closure. */
export const resolveNamespaceSelection = ({
  catalog,
  choices,
  includeOptional,
  namespace,
}: ResolveNamespaceSelectionInput): NamespaceSelection => {
  const entries = catalogSelectableEntries(catalog);
  const selection = resolveInitialSelection({
    choices,
    entries,
    namespace,
  });
  return {
    resolution: resolveDependencyClosure({
      entries,
      includeOptional,
      initialSelection: selection,
      quarantined: catalog.quarantined,
      sources: catalog.sources ?? [],
    }),
    selection,
  };
};
