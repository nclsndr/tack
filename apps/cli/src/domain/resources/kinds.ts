import { Schema } from "effect";

/** The resource kinds observable in the unified catalog. */
export const ResourceKindSchema = Schema.Literals([
  "skill",
  "command",
  "context",
  "script",
  "docs",
]);
/** A resource kind observable in the unified catalog. */
export type ResourceKind = typeof ResourceKindSchema.Type;

/** What Tack does with resources of one kind. */
type ResourceKindTraits = {
  /** A namespace can include or exclude it, so it takes part in selection. */
  readonly selectable: boolean;
  /** An agent adapter delivers it as a managed symbolic link. */
  readonly linkable: boolean;
  /** A skill or command can name it as a dependency. */
  readonly dependencyTarget: boolean;
  /** `tack import` can copy it from an upstream repository. */
  readonly importable: boolean;
  /** Its Tack metadata sets an activation, dependencies and projects. */
  readonly activation: boolean;
  /** The `tack.yaml` key that declares resources of this kind. */
  readonly declarationKey: string;
  /** What one resource of this kind is on disk, and so what a link to it points at. */
  readonly entryType: "file" | "directory";
};

/**
 * One row per resource kind. Every set of kinds and every per-kind fact is read from here, so
 * adding a kind is one row the compiler asks for, not a search for hand-spelled lists.
 */
export const resourceKinds = {
  skill: {
    selectable: true,
    linkable: true,
    dependencyTarget: true,
    importable: true,
    activation: true,
    declarationKey: "skills",
    entryType: "directory",
  },
  command: {
    selectable: true,
    linkable: true,
    dependencyTarget: true,
    importable: false,
    activation: true,
    declarationKey: "commands",
    entryType: "file",
  },
  context: {
    selectable: true,
    linkable: false,
    dependencyTarget: false,
    importable: false,
    activation: false,
    declarationKey: "context",
    entryType: "file",
  },
  script: {
    selectable: false,
    linkable: false,
    dependencyTarget: false,
    importable: false,
    activation: false,
    declarationKey: "scripts",
    entryType: "file",
  },
  docs: {
    selectable: false,
    linkable: false,
    dependencyTarget: false,
    importable: false,
    activation: false,
    declarationKey: "docs",
    entryType: "directory",
  },
} as const satisfies Record<ResourceKind, ResourceKindTraits>;

type ResourceKindFlag =
  | "selectable"
  | "linkable"
  | "dependencyTarget"
  | "importable"
  | "activation";

/** The kinds whose row sets one flag. */
type KindsWhere<Flag extends ResourceKindFlag> = {
  [Kind in ResourceKind]: (typeof resourceKinds)[Kind][Flag] extends true ? Kind : never;
}[ResourceKind];

/** A kind that takes part in namespace selection: skill, command or context. */
export type SelectableKind = KindsWhere<"selectable">;
/** A kind that adapters deliver as a managed link: skill or command. */
export type LinkableKind = KindsWhere<"linkable">;
/** A kind whose Tack metadata sets an activation: skill or command. */
export type ActivationKind = KindsWhere<"activation">;

/** Lists the kinds whose row sets one flag, in catalog order. */
const kindsWhere = <Flag extends ResourceKindFlag>(flag: Flag): ReadonlyArray<KindsWhere<Flag>> =>
  ResourceKindSchema.literals.filter(
    (kind): kind is KindsWhere<Flag> => resourceKinds[kind][flag] === true,
  );

/** The kinds that take part in namespace selection, in catalog order. */
export const selectableKinds = kindsWhere("selectable");
/** The kinds that adapters deliver as managed links, in catalog order. */
export const linkableKinds = kindsWhere("linkable");
/** The kinds a dependency edge can point at, in catalog order. */
export const dependencyTargetKinds = kindsWhere("dependencyTarget");

/** Whether resources of this kind take part in namespace selection. */
export const isSelectableKind = (kind: ResourceKind): kind is SelectableKind =>
  resourceKinds[kind].selectable;

/** Whether adapters deliver resources of this kind as managed links. */
export const isLinkableKind = (kind: ResourceKind): kind is LinkableKind =>
  resourceKinds[kind].linkable;

/** Whether a resource of this kind sets an activation, narrowing any union keyed by `kind`. */
export const hasActivation = <Value extends { readonly kind: ResourceKind }>(
  value: Value,
): value is Extract<Value, { readonly kind: ActivationKind }> =>
  resourceKinds[value.kind].activation;
