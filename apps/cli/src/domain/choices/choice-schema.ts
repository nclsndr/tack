import { Match, Schema } from "effect";
import { ProjectNameSchema } from "../projects/project-schema.ts";
import {
  SelectableAddressSchema,
  resourceAddressIdentity,
  type SelectableAddress,
} from "../sources/catalog-schema.ts";

/** The two explicit decisions an operator can persist for one exact resource. */
export const ChoiceDecisionSchema = Schema.Literals(["include", "exclude"]);

/** A namespace that owns an independent set of exact resource choices. */
export const ChoiceNamespaceSchema = Schema.Union([
  Schema.TaggedStruct("project", { projectName: ProjectNameSchema }),
  Schema.TaggedStruct("user", {}),
]);

/** One explicit selection decision persisted under a project or user namespace. */
export const SkillChoiceSchema = Schema.Struct({
  address: SelectableAddressSchema,
  decision: ChoiceDecisionSchema,
  namespace: ChoiceNamespaceSchema,
});

/** A persisted choice decision. */
export type ChoiceDecision = typeof ChoiceDecisionSchema.Type;

/** A project or user choice namespace. */
export type ChoiceNamespace = typeof ChoiceNamespaceSchema.Type;

/** One validated exact resource choice. */
export type SkillChoice = typeof SkillChoiceSchema.Type;

/** Returns the canonical comparison and lookup key for one choice namespace. */
export const choiceNamespaceIdentity = Match.type<ChoiceNamespace>().pipe(
  Match.tag("project", (namespace) => `project\u0000${namespace.projectName}`),
  Match.tag("user", () => "user"),
  Match.exhaustive,
);

/** Returns the canonical identity for one exact choice within its namespace. */
export const skillChoiceIdentity = (choice: {
  readonly address: SelectableAddress;
  readonly namespace: ChoiceNamespace;
}) =>
  `${choiceNamespaceIdentity(choice.namespace)}\u0000${resourceAddressIdentity(choice.address)}`;
