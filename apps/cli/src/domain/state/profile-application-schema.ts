import { Schema } from "effect";
import { ChoiceNamespaceSchema } from "../choices/choice-schema.ts";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";
import { ResourceAddressSchema, resourceAddressIdentity } from "../sources/catalog-schema.ts";
import { SourceRegistrationIdSchema } from "../sources/source-schema.ts";

/** Exact local intent retained even after an empty or incomplete application. */
export const ProfileApplicationSchema = Schema.Struct({
  namespace: ChoiceNamespaceSchema,
  profileName: Schema.String,
  sourceRegistrationId: SourceRegistrationIdSchema,
  direct: Schema.Array(ResourceAddressSchema),
  inventory: Schema.Array(ResourceAddressSchema),
  targets: Schema.Array(CanonicalPathSchema),
}).check(
  Schema.makeFilter((application) => {
    const inventory = new Set(
      application.inventory.map((address) => resourceAddressIdentity(address)),
    );
    return [
      ...(application.direct.every((address) => inventory.has(resourceAddressIdentity(address)))
        ? []
        : ["Direct members must belong to retained inventory."]),
      ...(inventory.size === application.inventory.length
        ? []
        : ["Retained inventory must be unique."]),
      ...(new Set(application.targets).size === application.targets.length
        ? []
        : ["Target roots must be unique."]),
    ];
  }),
);
export type ProfileApplication = typeof ProfileApplicationSchema.Type;
