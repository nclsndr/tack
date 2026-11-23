import { Schema } from "effect";
import { agentAdapterDescriptor } from "../agents/agent-adapter.ts";
import { deliversKind, managedLinkDestinationPath } from "../agents/agent-layout.ts";
import { AgentAdapterIdSchema, type AgentAdapterId } from "../links/agent-adapter-schema.ts";
import type { ResourceAddress } from "../sources/catalog-schema.ts";
import type { ProfileApplication } from "./profile-application.ts";

/**
 * A member one enabled agent cannot take, such as a command for an agent Tack links no commands
 * for. The member still reaches every agent that takes it, so a skip is not a failure.
 */
export const ProfileDeliverySkipSchema = Schema.Struct({
  member: Schema.String,
  adapter: AgentAdapterIdSchema,
  reason: Schema.String,
});

export type ProfileDeliverySkip = typeof ProfileDeliverySkipSchema.Type;

/** Capability assessment shared by apply, retry and health consumers. */
export const ProfileDeliverySchema = Schema.Struct({
  notes: Schema.Array(Schema.String),
  issues: Schema.Array(Schema.String),
  skipped: Schema.Array(ProfileDeliverySkipSchema),
  incomplete: Schema.Boolean,
});

/** How a delivery note names its member: `skill <registration id>:review`. */
export const deliveryMemberName = (address: ResourceAddress) =>
  `${address.kind} ${address.sourceRegistrationId}:${address.name}`;

/** The delivery note of a skipped member, as `notes` lists it. */
export const skipNote = (skip: ProfileDeliverySkip) => `${skip.member}: ${skip.reason}`;

type DeliveryResult =
  | { readonly _tag: "note"; readonly text: string }
  | { readonly _tag: "issue"; readonly text: string }
  | { readonly _tag: "skipped"; readonly skip: ProfileDeliverySkip };

const resultText = (result: DeliveryResult) =>
  result._tag === "skipped" ? skipNote(result.skip) : result.text;

/**
 * Explains each kind's real delivery role without executing or importing resource content. A
 * member an enabled agent cannot take is skipped for that agent; delivery is incomplete only when a
 * member cannot be delivered as the application asks, such as with no enabled adapter.
 */
export const profileDelivery = (
  application: ProfileApplication,
  adapters: ReadonlyArray<AgentAdapterId>,
) => {
  const results = application.inventory.flatMap((address): ReadonlyArray<DeliveryResult> => {
    const name = deliveryMemberName(address);
    if (address.kind === "context")
      return [{ _tag: "note", text: `${name}: inspectable, no adapter link` }];
    if (address.kind === "script")
      return [
        {
          _tag: "note",
          text: `${name}: available for explicit script run; never executed by profile operations`,
        },
      ];
    if (address.kind === "docs")
      return [
        application.namespace._tag === "project"
          ? { _tag: "note", text: `${name}: project docs mounts` }
          : { _tag: "issue", text: `${name}: blocked, docs require a project target` },
      ];
    if (adapters.length === 0) return [{ _tag: "issue", text: `${name}: no enabled adapter` }];
    const kind = address.kind;
    return adapters.flatMap((adapter) =>
      application.targets.map((canonicalPath): DeliveryResult => {
        const target = {
          _tag:
            application.namespace._tag === "user" ? ("user" as const) : ("project-root" as const),
          canonicalPath,
        };
        return deliversKind(agentAdapterDescriptor(adapter), target, kind)
          ? {
              _tag: "note",
              text: `${name}: ${adapter} → ${managedLinkDestinationPath({ adapter, address: { kind, name: address.name }, target })}`,
            }
          : {
              _tag: "skipped",
              skip: { member: name, adapter, reason: `Tack does not link ${kind}s for ${adapter}` },
            };
      }),
    );
  });
  const issues = results.flatMap((result) => (result._tag === "issue" ? [result.text] : []));
  // One entry per member and agent, however many targets the application has.
  const skipped = [
    ...new Map(
      results.flatMap((result) =>
        result._tag === "skipped" ? [[skipNote(result.skip), result.skip] as const] : [],
      ),
    ).values(),
  ];
  return {
    issues,
    notes: [...new Set(results.map(resultText))],
    skipped,
    incomplete: issues.length > 0,
  } satisfies typeof ProfileDeliverySchema.Type;
};
