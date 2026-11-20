import { Schema } from "effect";
import { agentAdapterDescriptor } from "../agents/agent-adapter.ts";
import { deliversKind, managedLinkDestinationPath } from "../agents/agent-layout.ts";
import type { AgentAdapterId } from "../links/agent-adapter-schema.ts";
import type { ResourceAddress } from "../sources/catalog-schema.ts";
import type { ProfileApplication } from "./profile-application.ts";

/** Capability assessment shared by apply, retry and health consumers. */
export const ProfileDeliverySchema = Schema.Struct({
  notes: Schema.Array(Schema.String),
  issues: Schema.Array(Schema.String),
  incomplete: Schema.Boolean,
});

/** How a delivery note names its member: `skill <registration id>:review`. */
export const deliveryMemberName = (address: ResourceAddress) =>
  `${address.kind} ${address.sourceRegistrationId}:${address.name}`;

/** Explains each kind's real delivery role without executing or importing resource content. */
export const profileDelivery = (
  application: ProfileApplication,
  adapters: ReadonlyArray<AgentAdapterId>,
) => {
  const results = application.inventory.flatMap((address) => {
    const name = deliveryMemberName(address);
    if (address.kind === "context")
      return [{ incomplete: false, text: `${name}: inspectable, no adapter link` }];
    if (address.kind === "script")
      return [
        {
          incomplete: false,
          text: `${name}: available for explicit script run; never executed by profile operations`,
        },
      ];
    if (address.kind === "docs")
      return [
        {
          incomplete: application.namespace._tag !== "project",
          text: `${name}: ${application.namespace._tag === "project" ? "project docs mounts" : "blocked, docs require a project target"}`,
        },
      ];
    if (adapters.length === 0) return [{ incomplete: true, text: `${name}: no enabled adapter` }];
    const kind = address.kind;
    return adapters.flatMap((adapter) =>
      application.targets.map((canonicalPath) => {
        const target = {
          _tag:
            application.namespace._tag === "user" ? ("user" as const) : ("project-root" as const),
          canonicalPath,
        };
        const supported = deliversKind(agentAdapterDescriptor(adapter), target, kind);
        return {
          incomplete: supported === false,
          text: supported
            ? `${name}: ${adapter} → ${managedLinkDestinationPath({ adapter, address: { kind, name: address.name }, target })}`
            : `${name}: ${adapter} cannot deliver ${kind} links`,
        };
      }),
    );
  });
  const issues = results.filter((entry) => entry.incomplete === true).map((entry) => entry.text);
  return {
    issues,
    notes: results.map((entry) => entry.text),
    incomplete: issues.length > 0,
  };
};
