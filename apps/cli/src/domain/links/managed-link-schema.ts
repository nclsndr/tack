import { Schema } from "effect";
import { agentAdapterDescriptor } from "../agents/agent-adapter.ts";
import { deliversKind } from "../agents/agent-layout.ts";
import type { Namespace } from "../choices/choice-schema.ts";
import { AgentAdapterIdSchema } from "../agents/agent-adapter-schema.ts";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";
import { ProjectNameSchema } from "../projects/project-schema.ts";
import { resourceAddressIdentity, LinkableAddressSchema } from "../sources/catalog-schema.ts";
import { SourceRegistrationIdSchema } from "../sources/source-schema.ts";

/** One concrete root whose adapter directory can contain Tack-managed links. */
export const ManagedLinkTargetSchema = Schema.Union([
  Schema.TaggedStruct("project-root", {
    canonicalPath: CanonicalPathSchema,
    projectName: ProjectNameSchema,
  }),
  Schema.TaggedStruct("user", { canonicalPath: CanonicalPathSchema }),
]);

/** Durable evidence for the exact relative link Tack created at one physical destination. */
export const ManagedLinkEvidenceSchema = Schema.Struct({
  adapter: AgentAdapterIdSchema,
  address: LinkableAddressSchema,
  sourceDirectoryPath: CanonicalPathSchema,
  sourceRegistrationId: SourceRegistrationIdSchema,
  target: ManagedLinkTargetSchema,
}).check(
  Schema.makeFilter((evidence) => [
    ...(evidence.address.sourceRegistrationId === evidence.sourceRegistrationId
      ? []
      : ["Managed-link evidence must name one source for its address and its registration."]),
    ...(deliversKind(
      agentAdapterDescriptor(evidence.adapter),
      evidence.target,
      evidence.address.kind,
    ) === false
      ? ["Managed-link evidence requires an adapter destination for its resource kind."]
      : []),
  ]),
);

/** A concrete managed link target. */
export type ManagedLinkTarget = typeof ManagedLinkTargetSchema.Type;

/** Persistent deletion authority for one managed relative link. */
export type ManagedLinkEvidence = typeof ManagedLinkEvidenceSchema.Type;

/** Returns the physical destination identity without relying on a live catalog or project. */
export const managedLinkDestinationIdentity = (evidence: ManagedLinkEvidence) =>
  `${evidence.target.canonicalPath}\u0000${evidence.adapter}\u0000${evidence.address.kind}\u0000${evidence.address.name}`;

/** Returns the stable identity of one concrete managed-link target. */
export const managedLinkTargetIdentity = (target: ManagedLinkTarget) =>
  target._tag === "project-root"
    ? `project\u0000${target.projectName}\u0000${target.canonicalPath}`
    : `user\u0000${target.canonicalPath}`;

/** Returns the choice namespace whose selection one concrete managed-link target receives. */
export const managedLinkTargetNamespace = (target: ManagedLinkTarget): Namespace =>
  target._tag === "project-root"
    ? { _tag: "project", projectName: target.projectName }
    : { _tag: "user" };

/** Compares durable ownership evidence without consulting live filesystem state. */
export const managedLinkEvidenceEqual = (left: ManagedLinkEvidence, right: ManagedLinkEvidence) =>
  left.adapter === right.adapter &&
  resourceAddressIdentity(left.address) === resourceAddressIdentity(right.address) &&
  left.sourceDirectoryPath === right.sourceDirectoryPath &&
  left.sourceRegistrationId === right.sourceRegistrationId &&
  managedLinkTargetIdentity(left.target) === managedLinkTargetIdentity(right.target);

/** Persisted managed-link evidence is unique by concrete destination path. */
export const ManagedLinkEvidenceCollectionSchema = Schema.Array(ManagedLinkEvidenceSchema).check(
  Schema.makeFilter((evidence) =>
    new Set(evidence.map(managedLinkDestinationIdentity)).size === evidence.length
      ? []
      : ["Managed-link evidence must be unique by physical destination."],
  ),
);
