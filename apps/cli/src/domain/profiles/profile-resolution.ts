import { portableSourceName } from "./portable-source-name.ts";
import {
  builtinProfileSourceIds,
  profileControlledAddresses,
  profileHasErrors,
} from "./profile-policy.ts";
import {
  resourceAddressIdentity,
  type Catalog,
  type ResourceAddress,
} from "../sources/catalog-schema.ts";
import { profileDependencyClosure } from "./profile-closure.ts";
import type { Profile, ProfileFinding, ProfileCheckReport } from "./profile-schema.ts";

/** Resolves a fixed positive inventory, ignoring picks, activation and project compatibility. */
export const resolveProfile = (
  profile: Profile,
  ownerId: string,
  catalog: Catalog,
  file: string,
): Pick<ProfileCheckReport, "direct" | "required" | "findings" | "linkage"> => {
  const findings: ProfileFinding[] = [];
  const issue = (
    code: string,
    message: string,
    remedy: string,
    field?: string,
    candidates?: ReadonlyArray<ResourceAddress>,
  ) =>
    findings.push({
      code,
      category: "linkage",
      severity: "error",
      file,
      message,
      remedy,
      ...(field === undefined ? {} : { field }),
      ...(candidates === undefined ? {} : { candidates }),
    });
  const sources = catalog.sources ?? [];
  const builtinSources = builtinProfileSourceIds(catalog);
  const warnBuiltin = (name: string, field?: string) =>
    findings.push({
      code: "profile-builtin-omitted",
      category: "linkage",
      severity: "warning",
      file,
      message: `Built-in skill ${name} omitted. Release-owned skills are always delivered and locked.`,
      remedy: "Remove this member from the profile; release-owned delivery remains independent.",
      ...(field === undefined ? {} : { field }),
    });
  const bindings = sources.find((source) => source.registration.id === ownerId)?.registration
    .bundle;
  const sourceId = (name: string, field: string) => {
    const ambient = sources.find(
      (source) =>
        source.status === "healthy" && source.origin === "builtin" && source.label === name,
    );
    if (ambient !== undefined) return ambient.registration.id;
    const matches = sources.filter(
      (source) =>
        source.status === "healthy" &&
        (bindings === undefined
          ? source.label === name
          : source.registration.id === bindings.bindings[name] &&
            source.registration.bundle?.identity === bindings.identity),
    );
    if (matches.length !== 1) {
      issue(
        matches.length === 0 ? "profile-source-unregistered" : "profile-source-ambiguous",
        `Required source ${name} is ${matches.length === 0 ? "not registered and healthy" : "ambiguous"}.`,
        matches.length === 0
          ? `For source-based use, register the available source named ${name}; check does not fetch it. A bundle may provide it later.`
          : `Give the sources distinct portable names; registration UUIDs cannot repair a profile.`,
        field,
      );
      return undefined;
    }
    const matched = matches[0];
    if (
      bindings === undefined &&
      matched !== undefined &&
      portableSourceName(catalog, matched.registration.id) !== name
    ) {
      issue(
        "profile-source-name",
        `Required source ${name} has only a local directory label.`,
        `Declare name: ${name} in ${matched.registration.canonicalPath}/tack.yaml and keep that portable name distinct.`,
        field,
      );
      return undefined;
    }
    return matched?.registration.id;
  };
  const requirements = new Map(
    (profile["depends-on"] ?? []).map((name) => [name, sourceId(name, "depends-on")]),
  );
  const direct = profile.members.flatMap((value, index) => {
    const member = typeof value === "string" ? { name: value } : value;
    const field = `members[${index}]`;
    if (member.source !== undefined && requirements.has(member.source) === false) {
      issue(
        "profile-source-undeclared",
        `Member ${member.name} names undeclared source ${member.source}.`,
        `Add ${member.source} to this profile's depends-on list.`,
        field,
      );
      return [];
    }
    const id = member.source === undefined ? ownerId : requirements.get(member.source);
    if (id === undefined) return [];
    if ((member.kind === undefined || member.kind === "skill") && builtinSources.has(id) === true) {
      warnBuiltin(member.name, field);
      return [];
    }
    const matches = catalog.entries.filter(
      (entry) =>
        entry.sourceRegistrationId === id &&
        entry.address.name === member.name &&
        (member.kind === undefined || entry.address.kind === member.kind),
    );
    if (matches.length !== 1) {
      const quarantined = catalog.quarantined.some(
        (entry) =>
          entry.sourceRegistrationId === id &&
          entry.address?.name === member.name &&
          (member.kind === undefined || entry.address.kind === member.kind),
      );
      issue(
        matches.length > 1
          ? "profile-member-ambiguous"
          : quarantined
            ? "profile-member-quarantined"
            : "profile-member-missing",
        `Member ${member.name} is ${matches.length > 1 ? "ambiguous across kinds" : quarantined ? "quarantined" : "missing in its owning source"}.`,
        matches.length > 1
          ? `Add kind to the member: ${matches.map((entry) => `${entry.address.kind} ${member.name}`).join(", ")}.`
          : `Repair ${member.name} in its owning source or edit this member; a different source never substitutes for it.`,
        field,
        matches.map((entry) => entry.address),
      );
      return [];
    }
    return matches.map((entry) => entry.address);
  });
  const uniqueDirect = [
    ...new Map(direct.map((address) => [resourceAddressIdentity(address), address])).values(),
  ];
  const directKeys = new Set(uniqueDirect.map((address) => resourceAddressIdentity(address)));
  const closure = profileDependencyClosure(catalog, uniqueDirect);
  const blockers = new Map(
    closure.groups.flatMap((group) =>
      group._tag === "blocked"
        ? group.blockers.map((blocker) => [JSON.stringify(blocker), blocker] as const)
        : [],
    ),
  );
  for (const blocker of blockers.values())
    issue(
      `profile-${blocker._tag}`,
      `${blocker.requester.kind} ${blocker.requester.name} needs ${blocker.dependency.kind} ${blocker.dependency.name}: ${blocker._tag}.`,
      `Repair ${blocker.dependency.name} and its owning resource's source depends-on declaration; register missing sources or give ambiguous sources distinct names.`,
    );
  const required = closure.groups
    .flatMap((group) => group.members)
    .filter((address) => directKeys.has(resourceAddressIdentity(address)) === false);
  const controlledRequired = profileControlledAddresses(catalog, required);
  const controlledKeys = new Set(controlledRequired.map(resourceAddressIdentity));
  for (const address of required)
    if (controlledKeys.has(resourceAddressIdentity(address)) === false) warnBuiltin(address.name);
  return {
    direct: uniqueDirect,
    required: controlledRequired,
    findings,
    linkage: profileHasErrors(findings) === false ? "complete" : "incomplete",
  };
};
