import { Effect } from "effect";
import { builtinSkillLockReason, isBuiltinSkill } from "../../domain/choices/builtin.ts";
import {
  resourceAddressIdentity,
  type Catalog,
  type SelectableAddress,
} from "../../domain/sources/catalog-schema.ts";
import { ResourceReferenceError } from "../sources/resource-reference.ts";

/** Refuses a choice mutation using the current catalog's release-owned marker. */
export const requireMutableChoice = Effect.fnUntraced(function* (
  catalog: Pick<Catalog, "entries">,
  address: SelectableAddress,
) {
  const entry = catalog.entries.find(
    (candidate) => resourceAddressIdentity(candidate.address) === resourceAddressIdentity(address),
  );
  if (entry !== undefined && isBuiltinSkill(entry)) {
    return yield* new ResourceReferenceError({
      code: "builtin-skill-locked",
      message: builtinSkillLockReason,
      candidates: [],
    });
  }
  return undefined;
});
