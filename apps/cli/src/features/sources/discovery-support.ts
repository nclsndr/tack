import type { SourceRegistration } from "../../domain/sources/source-schema.ts";
import type { ResourceKind } from "../../domain/resources/kinds.ts";
import type { CatalogQuarantine, ResourceAddress } from "../../domain/sources/catalog-schema.ts";
import type { DeclarationRecord } from "../../domain/sources/declaration-facts.ts";

/** A bounded filesystem candidate, before kind-specific content validation. */
export type ResourceCandidate = {
  readonly filePath: string;
  readonly source: SourceRegistration;
  /** The declared path of the entry that found this candidate; absent for a collection. */
  readonly declaredPath?: string;
  /** Whether a collection found this candidate, rather than an entry with a path. */
  readonly collection?: true;
  /** The declaration that found this candidate, which collects its problems. */
  readonly record: DeclarationRecord;
} & (
  | { readonly kind: "skill"; readonly address?: ResourceAddress }
  | { readonly kind: "command"; readonly address?: ResourceAddress }
  | { readonly kind: "context"; readonly address: ResourceAddress }
  | {
      readonly kind: "script";
      readonly address: ResourceAddress;
      readonly description: string;
      /** A script is always declared by an entry that names its file. */
      readonly declaredPath: string;
    }
);

/** Reports one local failure without inventing unseen resource identities. */
export const catalogQuarantine = (
  source: SourceRegistration,
  directoryPath: string,
  code: CatalogQuarantine["code"],
  message: string,
  address?: ResourceAddress,
  filePath?: string,
  candidateKind: ResourceKind | undefined = address?.kind,
): CatalogQuarantine => ({
  ...(candidateKind === undefined ? {} : { candidateKind }),
  code,
  directoryPath,
  message,
  sourcePath: source.canonicalPath,
  sourceRegistrationId: source.id,
  ...(address === undefined ? {} : { address }),
  ...(filePath === undefined ? {} : { filePath }),
});
