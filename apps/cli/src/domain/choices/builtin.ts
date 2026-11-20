/** Release ownership is catalog provenance, independent of a skill's name or source ID. */
export const isBuiltinSkill = (entry: {
  readonly origin?: string;
  readonly address: { readonly kind: string };
}): boolean => entry.origin === "builtin" && entry.address.kind === "skill";

/** The reason choice mutations cannot change release-owned skills. */
export const builtinSkillLockReason =
  "Built-in skills are managed by the release and cannot be changed here.";
