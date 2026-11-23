import { Schema } from "effect";
import { CanonicalPathSchema } from "../identity/identity-schema.ts";
import { compareCodeUnits, sortAndDedupeBy } from "../identity/ordering.ts";
import type { InitialSelection } from "./selection.ts";
import {
  SelectableAddressSchema,
  ResourceDependencySchema,
  catalogSelectableEntries,
  resourceAddressIdentity,
  type CatalogQuarantine,
  type Catalog,
  type SelectableAddress,
  type SelectableCatalogEntry,
} from "../sources/catalog-schema.ts";

/**
 * The paths of the registered sources Tack cannot read when a dependency's source label names no
 * readable one. Their labels are unknown, so any of them may be the source the dependency names.
 */
const UnhealthySourcesSchema = Schema.NonEmptyArray(CanonicalPathSchema);

/** Why a required dependency keeps its requester's dependency group from being selected. */
export const RequiredDependencyBlockerSchema = Schema.Union([
  Schema.TaggedStruct("required-missing", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
  Schema.TaggedStruct("required-quarantined", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
  Schema.TaggedStruct("required-excluded", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
  Schema.TaggedStruct("required-source-undeclared", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
  Schema.TaggedStruct("required-source-unregistered", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
  Schema.TaggedStruct("required-source-unhealthy", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
    unhealthySources: UnhealthySourcesSchema,
  }),
  Schema.TaggedStruct("required-ambiguous", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
]);

const DependencyGroupSchema = Schema.Union([
  Schema.TaggedStruct("selected", {
    members: Schema.NonEmptyArray(SelectableAddressSchema),
  }),
  Schema.TaggedStruct("blocked", {
    blockers: Schema.NonEmptyArray(RequiredDependencyBlockerSchema),
    members: Schema.NonEmptyArray(SelectableAddressSchema),
  }),
]);

const OptionalDependencySkipSchema = Schema.Union([
  Schema.TaggedStruct("optional-missing", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
  Schema.TaggedStruct("optional-quarantined", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
  Schema.TaggedStruct("optional-excluded", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
  Schema.TaggedStruct("optional-source-undeclared", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
  Schema.TaggedStruct("optional-source-unregistered", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
  Schema.TaggedStruct("optional-source-unhealthy", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
    unhealthySources: UnhealthySourcesSchema,
  }),
  Schema.TaggedStruct("optional-ambiguous", {
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
  Schema.TaggedStruct("optional-required-closure-blocked", {
    blockers: Schema.NonEmptyArray(RequiredDependencyBlockerSchema),
    dependency: ResourceDependencySchema,
    requester: SelectableAddressSchema,
  }),
]);

const RequestedSkillBlockerSchema = Schema.Union([
  Schema.TaggedStruct("requested-missing", { address: SelectableAddressSchema }),
  Schema.TaggedStruct("requested-quarantined", { address: SelectableAddressSchema }),
]);

/** Deterministic dependency groups, optional skips, and explicit request failures. */
export const DependencyResolutionSchema = Schema.Struct({
  groups: Schema.Array(DependencyGroupSchema),
  optionalSkips: Schema.Array(OptionalDependencySkipSchema),
  requestBlockers: Schema.Array(RequestedSkillBlockerSchema),
});

/** The JSON-safe result of dependency closure. */
export type DependencyResolution = typeof DependencyResolutionSchema.Type;

/** One reason a required dependency blocks its requester. */
export type RequiredDependencyBlocker = typeof RequiredDependencyBlockerSchema.Type;
type OptionalDependencySkip = typeof OptionalDependencySkipSchema.Type;

/** Inputs to one pure dependency-closure calculation. */
export type ResolveDependencyClosureInput = {
  /** The selectable catalog resources the initial selection decided, which carry dependencies. */
  readonly entries: ReadonlyArray<SelectableCatalogEntry>;
  readonly includeOptional: boolean;
  readonly initialSelection: InitialSelection;
  readonly quarantined: ReadonlyArray<CatalogQuarantine>;
  readonly sources?: NonNullable<Catalog["sources"]>;
};

type RequiredGraph = {
  readonly directBlockers: ReadonlyMap<string, ReadonlyArray<RequiredDependencyBlocker>>;
  readonly edges: ReadonlyMap<string, ReadonlyArray<string>>;
};

type RequiredGroup = {
  readonly blockers: ReadonlyArray<RequiredDependencyBlocker>;
  readonly memberKeys: ReadonlyArray<string>;
  readonly requiredGroupKeys: ReadonlyArray<string>;
};

const asNonEmpty = <A>(values: ReadonlyArray<A>): [A, ...Array<A>] | undefined => {
  const [first, ...remaining] = values;
  return first === undefined ? undefined : [first, ...remaining];
};

const blockerIdentity = (blocker: RequiredDependencyBlocker) =>
  `${blocker._tag}\u0000${resourceAddressIdentity(blocker.requester)}\u0000${JSON.stringify(blocker.dependency)}`;

const optionalSkipIdentity = (skip: OptionalDependencySkip) =>
  `${resourceAddressIdentity(skip.requester)}\u0000${JSON.stringify(skip.dependency)}\u0000${skip._tag}`;

/**
 * Why a dependency names no single catalog resource, whatever any namespace selects, as the
 * stateless check reports it. Blockers and skips copy only the reason, never the names.
 */
type DependencyFindFailure =
  | { readonly reason: "missing" | "quarantined"; readonly target?: never }
  | {
      readonly reason: "ambiguous";
      readonly target?: never;
      /**
       * The name of each source the edge matches, once per source, in code-unit order. A name seen
       * twice is a label that several sources share.
       */
      readonly providers: ReadonlyArray<string>;
    }
  | {
      readonly reason: "source-undeclared";
      readonly target?: never;
      /**
       * For an edge that names no source, the labels, or paths when unlabelled, of the sources that
       * provide the resource without being declared, in code-unit order. Empty for a named source.
       */
      readonly providers: ReadonlyArray<string>;
    }
  | {
      readonly reason: "source-unregistered";
      readonly target?: never;
      /** The declared labels that no registered source carries. */
      readonly labels: readonly [string, ...Array<string>];
    }
  | {
      readonly reason: "source-unhealthy";
      readonly target?: never;
      readonly unhealthySources: typeof UnhealthySourcesSchema.Type;
    };

type DependencyFind =
  | { readonly target: SelectableAddress; readonly reason?: never }
  | DependencyFindFailure;

/**
 * Why a requester cannot use one dependency in a namespace, shared by required blockers and
 * optional skips: the dependency names no single resource, or the namespace excludes it.
 */
type DependencyLookupFailure =
  | DependencyFindFailure
  | { readonly reason: "excluded"; readonly target?: never };

type DependencyLookup =
  | { readonly target: SelectableAddress; readonly reason?: never }
  | DependencyLookupFailure;

/**
 * Why a declared source label resolves to no registered source: a registered source Tack cannot
 * read has an unknown label and may be that source, so it is unhealthy, not unregistered.
 */
const labelUnresolved = (
  sources: NonNullable<Catalog["sources"]>,
  labels: readonly [string, ...Array<string>],
): DependencyFindFailure => {
  const [first, ...remaining] = sources
    .filter((source) => source.status === "unhealthy" && source.label === undefined)
    .map((source) => source.registration.canonicalPath)
    .sort(compareCodeUnits);
  return first === undefined
    ? { reason: "source-unregistered", labels }
    : { reason: "source-unhealthy", unhealthySources: [first, ...remaining] };
};

/** What every dependency lookup of one catalog reads, built once so a lookup never scans it. */
type DependencyIndex = {
  /** The entries of each kind and name, across sources, keyed by {@link kindAndName}. */
  readonly byKindAndName: ReadonlyMap<string, ReadonlyArray<SelectableCatalogEntry>>;
  /** The identities of the quarantined resources. */
  readonly quarantined: ReadonlySet<string>;
  /** Each source's label, or its path when it has none, by registration ID. */
  readonly sourceNames: ReadonlyMap<string, string>;
  readonly sources: NonNullable<Catalog["sources"]>;
};

const kindAndName = (kind: string, name: string) => `${kind}\u0000${name}`;

/** Groups the entries by kind and name, so a lookup reads only the entries a dependency can name. */
const indexDependencies = (
  entries: Iterable<SelectableCatalogEntry>,
  quarantined: ReadonlyArray<CatalogQuarantine>,
  sources: NonNullable<Catalog["sources"]>,
): DependencyIndex => ({
  byKindAndName: [...entries].reduce((index, entry) => {
    const key = kindAndName(entry.address.kind, entry.address.name);
    return index.set(key, [...(index.get(key) ?? []), entry]);
  }, new Map<string, ReadonlyArray<SelectableCatalogEntry>>()),
  quarantined: new Set(
    quarantined.flatMap((item) =>
      item.address === undefined ? [] : [resourceAddressIdentity(item.address)],
    ),
  ),
  sourceNames: new Map(
    sources.map((source) => [
      source.registration.id,
      source.label ?? source.registration.canonicalPath,
    ]),
  ),
  sources,
});

/**
 * Finds the one resource a dependency names, or why it cannot. A dependency that names its source
 * looks only there, so a resource of the same name elsewhere leaves it missing.
 */
const findDependency = (
  requester: SelectableAddress,
  dependency: typeof ResourceDependencySchema.Type,
  { byKindAndName, quarantined, sourceNames, sources }: DependencyIndex,
): DependencyFind => {
  const candidates = byKindAndName.get(kindAndName(dependency.kind, dependency.name)) ?? [];
  /** The names of the given sources, in code-unit order. */
  const namesOf = (ids: ReadonlyArray<string>) =>
    ids.map((id) => sourceNames.get(id) ?? id).sort(compareCodeUnits);
  const ownId = requester.sourceRegistrationId;
  const own = sources.find((source) => source.registration.id === ownId);
  const declared = own?.dependsOn ?? [];
  const sourceIds = (label: string) => {
    const ambient = sources
      .filter(
        (source) =>
          source.status === "healthy" && source.origin === "builtin" && source.label === label,
      )
      .map((source) => source.registration.id);
    if (ambient.length > 0) return ambient;
    return own?.registration.bundle === undefined
      ? sources.filter((source) => source.label === label).map((source) => source.registration.id)
      : sources
          .filter(
            (source) =>
              source.registration.id === own.registration.bundle?.bindings[label] &&
              source.registration.bundle?.identity === own.registration.bundle.identity,
          )
          .map((source) => source.registration.id);
  };
  let allowedIds: ReadonlyArray<string>;
  if (dependency.source !== undefined) {
    if (
      dependency.source === own?.label ||
      dependency.source === ownId ||
      own?.registration.bundle?.bindings[dependency.source] === ownId
    )
      allowedIds = ownId === undefined ? [] : [ownId];
    else if (declared.includes(dependency.source)) allowedIds = sourceIds(dependency.source);
    else return { reason: "source-undeclared", providers: [] };
    if (allowedIds.length === 0) return labelUnresolved(sources, [dependency.source]);
    if (allowedIds.length > 1) return { reason: "ambiguous", providers: namesOf(allowedIds) };
  } else {
    const ownMatch = candidates.find((entry) => entry.sourceRegistrationId === ownId);
    if (ownMatch !== undefined) allowedIds = [ownMatch.sourceRegistrationId];
    else
      allowedIds = [
        ...(ownId === undefined ? [] : [ownId]),
        ...declared.flatMap((label) => sourceIds(label)),
      ];
  }
  const matches = candidates.filter((entry) => allowedIds.includes(entry.sourceRegistrationId));
  if (matches.length > 1)
    return {
      reason: "ambiguous",
      providers: namesOf(matches.map((entry) => entry.sourceRegistrationId)),
    };
  const target = matches[0]?.address;
  if (target === undefined) {
    if (dependency.source === undefined) {
      const [unresolved, ...moreUnresolved] = declared.filter(
        (label) => sourceIds(label).length === 0,
      );
      if (unresolved !== undefined)
        return labelUnresolved(sources, [unresolved, ...moreUnresolved]);
      const providers = namesOf(
        candidates
          .filter((entry) => allowedIds.includes(entry.sourceRegistrationId) === false)
          .map((entry) => entry.sourceRegistrationId),
      );
      if (providers.length > 0) return { reason: "source-undeclared", providers };
    }
    const quarantinedMatch = allowedIds.some((id) =>
      quarantined.has(
        resourceAddressIdentity({
          kind: dependency.kind,
          name: dependency.name,
          sourceRegistrationId: id,
        }),
      ),
    );
    return { reason: quarantinedMatch ? "quarantined" : "missing" };
  }
  return { target };
};

/** Finds the resource a dependency names, then refuses it when the namespace excludes it. */
const dependencyLookup = (
  requester: SelectableAddress,
  dependency: typeof ResourceDependencySchema.Type,
  index: DependencyIndex,
  excluded: ReadonlySet<string>,
): DependencyLookup => {
  const found = findDependency(requester, dependency, index);
  return found.target !== undefined && excluded.has(resourceAddressIdentity(found.target))
    ? { reason: "excluded" }
    : found;
};

/** One dependency edge of a skill or command that names no single catalog resource. */
export type UnresolvedDependencyEdge = {
  readonly requester: Extract<SelectableCatalogEntry, { readonly dependencies: unknown }>;
  readonly dependency: typeof ResourceDependencySchema.Type;
  /** The edge's zero-based position in the requester's `dependencies` list. */
  readonly position: number;
  readonly failure: DependencyFindFailure;
};

/**
 * Finds every dependency edge, required or optional, that names no single resource of the
 * catalog. It reads no selection, so no resource is excluded: what it reports breaks in every
 * namespace. The resolution's own lookup decides each edge.
 */
export const unresolvedDependencyEdges = (
  catalog: Pick<Catalog, "entries" | "quarantined" | "sources">,
): ReadonlyArray<UnresolvedDependencyEdge> => {
  const entries = catalogSelectableEntries(catalog);
  const index = indexDependencies(entries, catalog.quarantined, catalog.sources ?? []);
  return entries.flatMap((requester) =>
    "dependencies" in requester
      ? requester.dependencies.flatMap((dependency, position) => {
          const found = findDependency(requester.address, dependency, index);
          return found.target === undefined
            ? [{ requester, dependency, position, failure: found }]
            : [];
        })
      : [],
  );
};

const buildRequiredGraph = (
  entries: ReadonlyMap<string, SelectableCatalogEntry>,
  index: DependencyIndex,
  excluded: ReadonlySet<string>,
): RequiredGraph => {
  const directBlockers = new Map<string, ReadonlyArray<RequiredDependencyBlocker>>();
  const edges = new Map<string, ReadonlyArray<string>>();

  for (const [entryKey, entry] of entries) {
    const required = ("dependencies" in entry ? entry.dependencies : []).filter(
      (dependency) => dependency.optional !== true,
    );
    const blockers: Array<RequiredDependencyBlocker> = [];
    const targets: Array<string> = [];
    for (const dependency of required) {
      const lookup = dependencyLookup(entry.address, dependency, index, excluded);
      if (lookup.target !== undefined) {
        targets.push(resourceAddressIdentity(lookup.target));
      } else {
        blockers.push(
          lookup.reason === "source-unhealthy"
            ? {
                _tag: "required-source-unhealthy",
                dependency,
                requester: entry.address,
                unhealthySources: lookup.unhealthySources,
              }
            : { _tag: `required-${lookup.reason}`, dependency, requester: entry.address },
        );
      }
    }
    directBlockers.set(entryKey, sortAndDedupeBy(blockers, blockerIdentity));
    edges.set(entryKey, [...new Set(targets)].sort(compareCodeUnits));
  }

  return { directBlockers, edges };
};

const stronglyConnectedComponents = (
  nodeKeys: ReadonlyArray<string>,
  edges: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> => {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: Array<string> = [];
  const onStack = new Set<string>();
  const components: Array<ReadonlyArray<string>> = [];

  const visit = (nodeKey: string): void => {
    const nodeIndex = nextIndex;
    nextIndex += 1;
    indexes.set(nodeKey, nodeIndex);
    lowLinks.set(nodeKey, nodeIndex);
    stack.push(nodeKey);
    onStack.add(nodeKey);

    for (const targetKey of edges.get(nodeKey) ?? []) {
      if (indexes.has(targetKey) === false) {
        visit(targetKey);
        lowLinks.set(
          nodeKey,
          Math.min(lowLinks.get(nodeKey) ?? nodeIndex, lowLinks.get(targetKey) ?? nodeIndex),
        );
      } else if (onStack.has(targetKey)) {
        lowLinks.set(
          nodeKey,
          Math.min(lowLinks.get(nodeKey) ?? nodeIndex, indexes.get(targetKey) ?? nodeIndex),
        );
      }
    }

    if (lowLinks.get(nodeKey) !== nodeIndex) {
      return;
    }

    const component: Array<string> = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member !== undefined) {
        onStack.delete(member);
        component.push(member);
      }
    } while (member !== nodeKey);
    components.push(component.sort(compareCodeUnits));
  };

  for (const nodeKey of [...nodeKeys].sort(compareCodeUnits)) {
    if (indexes.has(nodeKey) === false) {
      visit(nodeKey);
    }
  }

  return components.sort((left, right) => compareCodeUnits(left[0] ?? "", right[0] ?? ""));
};

const buildRequiredGroups = (
  entries: ReadonlyMap<string, SelectableCatalogEntry>,
  graph: RequiredGraph,
): {
  readonly groups: ReadonlyMap<string, RequiredGroup>;
  readonly groupKeyByMember: ReadonlyMap<string, string>;
} => {
  const components = stronglyConnectedComponents([...entries.keys()], graph.edges);
  const groupKeyByMember = new Map<string, string>();
  for (const component of components) {
    const groupKey = component[0];
    if (groupKey === undefined) {
      continue;
    }
    for (const memberKey of component) {
      groupKeyByMember.set(memberKey, groupKey);
    }
  }

  const directBlockersByGroup = new Map<string, ReadonlyArray<RequiredDependencyBlocker>>();
  const requiredGroupsByGroup = new Map<string, ReadonlyArray<string>>();
  for (const component of components) {
    const groupKey = component[0];
    // Coverage skip: Tarjan's algorithm never emits an empty component; this only narrows the index.
    /* v8 ignore next -- @preserve */
    if (groupKey === undefined) {
      continue;
    }
    const directBlockers = component.flatMap(
      (memberKey) => graph.directBlockers.get(memberKey) ?? [],
    );
    const requiredGroups = component.flatMap((memberKey) =>
      (graph.edges.get(memberKey) ?? []).flatMap((targetKey) => {
        const targetGroupKey = groupKeyByMember.get(targetKey);
        return targetGroupKey === undefined || targetGroupKey === groupKey ? [] : [targetGroupKey];
      }),
    );
    directBlockersByGroup.set(groupKey, sortAndDedupeBy(directBlockers, blockerIdentity));
    requiredGroupsByGroup.set(groupKey, [...new Set(requiredGroups)].sort(compareCodeUnits));
  }

  const blockersMemo = new Map<string, ReadonlyArray<RequiredDependencyBlocker>>();
  const blockersFor = (groupKey: string): ReadonlyArray<RequiredDependencyBlocker> => {
    const memoized = blockersMemo.get(groupKey);
    if (memoized !== undefined) {
      return memoized;
    }
    const blockers = sortAndDedupeBy(
      [
        ...(directBlockersByGroup.get(groupKey) ?? []),
        ...(requiredGroupsByGroup.get(groupKey) ?? []).flatMap(blockersFor),
      ],
      blockerIdentity,
    );
    blockersMemo.set(groupKey, blockers);
    return blockers;
  };

  const groups = new Map<string, RequiredGroup>();
  for (const component of components) {
    const groupKey = component[0];
    if (groupKey !== undefined) {
      groups.set(groupKey, {
        blockers: blockersFor(groupKey),
        memberKeys: component,
        requiredGroupKeys: requiredGroupsByGroup.get(groupKey) ?? [],
      });
    }
  }
  return { groupKeyByMember, groups };
};

/** Resolves required SCCs and invocation-only optional closure without mutating state. */
export const resolveDependencyClosure = ({
  entries: catalogEntries,
  includeOptional,
  initialSelection,
  quarantined,
  sources = [],
}: ResolveDependencyClosureInput): DependencyResolution => {
  const entries = new Map(
    catalogEntries.map((entry) => [resourceAddressIdentity(entry.address), entry]),
  );
  const excluded = new Set(
    initialSelection.decisions.flatMap((decision) =>
      decision._tag === "not-selected" && decision.reason === "exclude"
        ? [resourceAddressIdentity(decision.address)]
        : [],
    ),
  );
  const index = indexDependencies(entries.values(), quarantined, sources);
  const graph = buildRequiredGraph(entries, index, excluded);
  const { groupKeyByMember, groups } = buildRequiredGroups(entries, graph);
  const selectedGroupKeys = new Set<string>();
  const blockedGroupKeys = new Set<string>();

  const selectHealthyClosure = (groupKey: string): void => {
    if (selectedGroupKeys.has(groupKey)) {
      return;
    }
    const group = groups.get(groupKey);
    // Coverage skip: callers pass only grouped, unblocked keys, and blockers propagate to requesters.
    /* v8 ignore next -- @preserve */
    if (group === undefined || group.blockers.length > 0) {
      return;
    }
    selectedGroupKeys.add(groupKey);
    for (const requiredGroupKey of group.requiredGroupKeys) {
      selectHealthyClosure(requiredGroupKey);
    }
  };

  const retainBlockedChain = (groupKey: string): void => {
    if (blockedGroupKeys.has(groupKey)) {
      return;
    }
    const group = groups.get(groupKey);
    if (group === undefined || group.blockers.length === 0) {
      return;
    }
    blockedGroupKeys.add(groupKey);
    for (const requiredGroupKey of group.requiredGroupKeys) {
      retainBlockedChain(requiredGroupKey);
    }
  };

  for (const decision of initialSelection.decisions) {
    if (decision._tag !== "selected") {
      continue;
    }
    const groupKey = groupKeyByMember.get(resourceAddressIdentity(decision.address));
    if (groupKey === undefined) {
      continue;
    }
    const group = groups.get(groupKey);
    if (group !== undefined && group.blockers.length > 0) {
      retainBlockedChain(groupKey);
    } else {
      selectHealthyClosure(groupKey);
    }
  }

  const optionalSkips: Array<OptionalDependencySkip> = [];
  if (includeOptional === true) {
    const processedGroups = new Set<string>();
    while (true) {
      const groupKey = [...selectedGroupKeys]
        .sort(compareCodeUnits)
        .find((candidate) => processedGroups.has(candidate) === false);
      if (groupKey === undefined) {
        break;
      }
      processedGroups.add(groupKey);
      const group = groups.get(groupKey);
      if (group === undefined) {
        continue;
      }
      for (const memberKey of group.memberKeys) {
        const member = entries.get(memberKey);
        if (member === undefined) {
          continue;
        }
        const optionalDependencies = ("dependencies" in member ? member.dependencies : [])
          .filter((dependency) => dependency.optional === true)
          .sort((left, right) =>
            compareCodeUnits(`${left.kind}\u0000${left.name}`, `${right.kind}\u0000${right.name}`),
          );
        for (const dependency of optionalDependencies) {
          const lookup = dependencyLookup(member.address, dependency, index, excluded);
          if (lookup.reason !== undefined) {
            optionalSkips.push(
              lookup.reason === "source-unhealthy"
                ? {
                    _tag: "optional-source-unhealthy",
                    dependency,
                    requester: member.address,
                    unhealthySources: lookup.unhealthySources,
                  }
                : { _tag: `optional-${lookup.reason}`, dependency, requester: member.address },
            );
            continue;
          }
          const targetGroupKey = groupKeyByMember.get(resourceAddressIdentity(lookup.target));
          if (targetGroupKey === undefined) {
            continue;
          }
          const targetGroup = groups.get(targetGroupKey);
          if (targetGroup === undefined) {
            continue;
          }
          if (targetGroup.blockers.length > 0) {
            const blockers = asNonEmpty(targetGroup.blockers);
            if (blockers === undefined) {
              continue;
            }
            optionalSkips.push({
              _tag: "optional-required-closure-blocked",
              blockers,
              dependency,
              requester: member.address,
            });
            continue;
          }
          selectHealthyClosure(targetGroupKey);
        }
      }
    }
  }

  const outputGroupKeys = [...new Set([...selectedGroupKeys, ...blockedGroupKeys])].sort(
    compareCodeUnits,
  );
  const outputGroups: Array<DependencyResolution["groups"][number]> = [];
  for (const groupKey of outputGroupKeys) {
    const group = groups.get(groupKey);
    if (group === undefined || group.memberKeys.length === 0) {
      continue;
    }
    const members = asNonEmpty(
      group.memberKeys
        .map((memberKey) => entries.get(memberKey)?.address)
        .filter((member): member is SelectableAddress => member !== undefined),
    );
    if (members === undefined) {
      continue;
    }
    if (blockedGroupKeys.has(groupKey)) {
      const blockers = asNonEmpty(group.blockers);
      if (blockers === undefined) {
        continue;
      }
      outputGroups.push({
        _tag: "blocked",
        blockers,
        members,
      });
    } else {
      outputGroups.push({ _tag: "selected", members });
    }
  }

  const requestBlockers = sortAndDedupeBy(
    [
      ...initialSelection.unresolvedChoices.flatMap((choice) =>
        choice.decision === "include"
          ? [
              index.quarantined.has(resourceAddressIdentity(choice.address))
                ? ({ _tag: "requested-quarantined", address: choice.address } as const)
                : ({ _tag: "requested-missing", address: choice.address } as const),
            ]
          : [],
      ),
    ],
    (blocker) => `${resourceAddressIdentity(blocker.address)}\u0000${blocker._tag}`,
  );

  return {
    groups: outputGroups,
    optionalSkips: sortAndDedupeBy(optionalSkips, optionalSkipIdentity),
    requestBlockers,
  };
};

/** Derives selected exact addresses solely from selected dependency groups. */
export const selectedDependencyAddresses = (
  resolution: DependencyResolution,
): ReadonlyArray<SelectableAddress> =>
  resolution.groups.flatMap((group) => (group._tag === "selected" ? group.members : []));

/** Whether a namespace's resolution leaves a requested or required resource unresolved. */
export const resolutionIsUnresolved = (resolution: DependencyResolution) =>
  resolution.requestBlockers.length > 0 ||
  resolution.groups.some((group) => group._tag === "blocked");
