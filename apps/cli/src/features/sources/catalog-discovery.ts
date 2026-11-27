import { Effect } from "effect";
import type { SourceDeclaration, SourceRegistration } from "../../domain/sources/source-schema.ts";
import { discoverDeclaredResources } from "./resource-declarations.ts";

export { catalogQuarantine, type ResourceCandidate } from "./discovery-support.ts";

/**
 * Turns the resource declarations of a healthy source into candidates and quarantines, with its
 * docs. Nothing is discovered by convention: a folder is read only when the source declares it.
 */
export const discoverSource = Effect.fnUntraced(function* (
  source: SourceRegistration,
  declaration: SourceDeclaration,
) {
  const declared = yield* discoverDeclaredResources(source, declaration);
  return {
    candidates: [...declared.candidates],
    quarantined: [...declared.quarantined],
    records: declared.records,
    docs: declared.docs,
  };
});
