import { Match, Schema } from "effect";
import { ProjectNameSchema } from "../projects/project-schema.ts";
import {
  LinkableAddressSchema,
  SelectableAddressSchema,
  resourceAddressIdentity,
  type SelectableAddress,
} from "../sources/catalog-schema.ts";

/** The two explicit decisions an operator can persist for one exact resource. */
export const ChoiceDecisionSchema = Schema.Literals(["include", "exclude"]);

/** A namespace that owns an independent set of exact resource choices. */
export const NamespaceSchema = Schema.Union([
  Schema.TaggedStruct("project", { projectName: ProjectNameSchema }),
  Schema.TaggedStruct("user", {}),
]);

/** One explicit selection decision persisted under a project or user namespace. */
export const SkillChoiceSchema = Schema.Struct({
  address: SelectableAddressSchema,
  decision: ChoiceDecisionSchema,
  namespace: NamespaceSchema,
});

/** A persisted choice decision. */
export type ChoiceDecision = typeof ChoiceDecisionSchema.Type;

/** A project or user choice namespace. */
export type Namespace = typeof NamespaceSchema.Type;

/** One validated exact resource choice. */
export type SkillChoice = typeof SkillChoiceSchema.Type;

/** Returns the canonical comparison and lookup key for one choice namespace. */
export const choiceNamespaceIdentity = Match.type<Namespace>().pipe(
  Match.tag("project", (namespace) => `project\u0000${namespace.projectName}`),
  Match.tag("user", () => "user"),
  Match.exhaustive,
);

/**
 * Returns the key two resources share when they have one kind and name, whatever their source:
 * they then compete for one destination, and a dependency by kind and name can mean either.
 */
export const kindAndNameKey = (resource: { readonly kind: string; readonly name: string }) =>
  `${resource.kind}\u0000${resource.name}`;

/** Returns the canonical identity for one exact choice within its namespace. */
export const skillChoiceIdentity = (choice: {
  readonly address: SelectableAddress;
  readonly namespace: Namespace;
}) =>
  `${choiceNamespaceIdentity(choice.namespace)}\u0000${resourceAddressIdentity(choice.address)}`;

/**
 * A project exclude that cannot hide its resource, because the user namespace links it: the
 * project's own link goes, but the user's stays in front of every agent in the project.
 */
export const UserLinkedExcludeSchema = Schema.Struct({
  address: LinkableAddressSchema,
  projectName: ProjectNameSchema,
});

/** A project exclude that cannot hide its resource; see {@link UserLinkedExcludeSchema}. */
export type UserLinkedExclude = typeof UserLinkedExcludeSchema.Type;
