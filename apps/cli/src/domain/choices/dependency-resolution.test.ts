import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import type { ChoiceNamespace, SkillChoice } from "./choice-schema.ts";
import {
  DependencyResolutionSchema,
  resolutionIsUnresolved,
  resolveDependencyClosure,
  selectedDependencyAddresses,
  unresolvedDependencyEdges,
} from "./dependency-resolution.ts";
import { resolveInitialSelection } from "./selection.ts";
import type {
  SelectableCatalogEntry,
  SkillCatalogEntry,
  CatalogQuarantine,
  Catalog,
} from "../sources/catalog-schema.ts";

/** The address of a skill, as a catalog entry carries it. */
type SkillAddress = SkillCatalogEntry["address"];

const userNamespace = { _tag: "user" } satisfies ChoiceNamespace;
const projectNamespace = { _tag: "project", projectName: "project" } satisfies ChoiceNamespace;

const address = (name: string, owner: "shared" | "private" = "shared") =>
  ({
    kind: "skill",
    name,
    sourceRegistrationId:
      owner === "shared"
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002",
  }) satisfies SkillAddress;

const dependency = (name: string, _owner: "shared" | "private" = "shared", optional = false) => ({
  kind: "skill" as const,
  name,
  ...(optional ? { optional: true as const } : {}),
});

const entry = (
  name: string,
  options: {
    readonly activation?: SkillCatalogEntry["activation"];
    readonly dependencies?: SkillCatalogEntry["dependencies"];
    readonly owner?: "shared" | "private";
    readonly projects?: ReadonlyArray<string>;
  } = {},
) => {
  const owner = options.owner ?? "shared";
  return {
    activation: options.activation ?? "default",
    userActivation: options.activation ?? "default",
    address: address(name, owner),
    dependencies: options.dependencies ?? [],
    description: `${name} description`,
    directoryPath: `/sources/${owner}/${name}`,
    frontmatter: { description: `${name} description`, name },
    projects: options.projects ?? [],
    skillFilePath: `/sources/${owner}/${name}/SKILL.md`,
    sourcePath: `/sources/${owner}`,
    sourceRegistrationId:
      owner === "shared"
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002",
  } satisfies SkillCatalogEntry;
};

const choice = (
  catalogAddress: SkillAddress,
  decision: SkillChoice["decision"],
  namespace: ChoiceNamespace = userNamespace,
) => ({ address: catalogAddress, decision, namespace }) satisfies SkillChoice;

const quarantine = (catalogAddress: SkillAddress) =>
  ({
    address: catalogAddress,
    code: "skill-frontmatter-schema-invalid",
    directoryPath: `/sources/${catalogAddress.sourceRegistrationId}/${catalogAddress.name}`,
    message: "invalid",
    skillFilePath: `/sources/${catalogAddress.sourceRegistrationId}/${catalogAddress.name}/SKILL.md`,
    sourcePath: `/sources/${catalogAddress.sourceRegistrationId}`,
    sourceRegistrationId:
      catalogAddress.sourceRegistrationId ?? "00000000-0000-4000-8000-000000000001",
  }) satisfies CatalogQuarantine;

const resolve = ({
  choices = [],
  entries,
  includeOptional = false,
  namespace = userNamespace,
  quarantined = [],
  sources = [],
}: {
  readonly choices?: ReadonlyArray<SkillChoice>;
  readonly entries: ReadonlyArray<SkillCatalogEntry>;
  readonly includeOptional?: boolean;
  readonly namespace?: ChoiceNamespace;
  readonly quarantined?: ReadonlyArray<CatalogQuarantine>;
  readonly sources?: NonNullable<Catalog["sources"]>;
}) =>
  resolveDependencyClosure({
    entries,
    includeOptional,
    initialSelection: resolveInitialSelection({ choices, entries, namespace }),
    quarantined,
    sources,
  });

const selectedNames = (result: ReturnType<typeof resolve>) =>
  selectedDependencyAddresses(result).map(
    ({ name, sourceRegistrationId }) =>
      `${sourceRegistrationId === "00000000-0000-4000-8000-000000000002" ? "private" : "shared"}/${name}`,
  );

const groupFor = (result: ReturnType<typeof resolve>, name: string) =>
  result.groups.find((group) => group.members.some((member) => member.name === name));

const source = (
  label: "shared" | "private",
  dependsOn: ReadonlyArray<string> = [],
): NonNullable<Catalog["sources"]>[number] => ({
  registration: {
    id:
      label === "shared"
        ? address("x").sourceRegistrationId
        : address("x", "private").sourceRegistrationId,
    canonicalPath: `/sources/${label}`,
  },
  status: "healthy",
  label,
  labelOrigin: "declared",
  dependsOn,
});

it("recursively acquires exact required opt-in and project-incompatible entries", () => {
  const root = entry("root", {
    dependencies: [dependency("opted"), dependency("incompatible")],
    projects: ["project"],
  });
  const opted = entry("opted", { activation: "opt-in" });
  const incompatible = entry("incompatible", { projects: ["another-project"] });

  const result = resolve({ entries: [incompatible, opted, root], namespace: projectNamespace });

  expect(selectedNames(result)).toEqual(["shared/incompatible", "shared/opted", "shared/root"]);
});

it("prefers a dependency in the requester's own source", () => {
  const root = entry("root", {
    dependencies: [dependency("same", "private")],
  });
  const shared = entry("same");
  const owned = entry("same", { activation: "opt-in", owner: "private" });

  const result = resolve({ entries: [shared, root, owned] });

  expect(selectedNames(result)).toEqual(["shared/root", "shared/same"]);
});

it.each([
  ["required-missing", [], []],
  ["required-quarantined", [], [quarantine(address("target"))]],
  ["required-excluded", [choice(address("target"), "exclude")], []],
] as const)("blocks a requester for an exact %s dependency", (code, choices, quarantined) => {
  const root = entry("root", { dependencies: [dependency("target")] });
  const target = entry("target");
  const entries =
    code === "required-missing" || code === "required-quarantined" ? [root] : [root, target];

  const result = resolve({ choices, entries, quarantined });

  expect(groupFor(result, "root")).toMatchObject({
    _tag: "blocked",
    blockers: [{ _tag: code, dependency: dependency("target"), requester: address("root") }],
  });
  expect(selectedNames(result)).toEqual([]);
});

it("distinguishes quarantined dependencies from missing ones only by exact address", () => {
  const root = entry("root", {
    dependencies: [dependency("target", "private")],
  });

  const result = resolve({
    entries: [root],
    quarantined: [
      quarantine(address("target", "shared")),
      quarantine(address("target", "private")),
    ],
  });

  expect(groupFor(result, "root")).toMatchObject({
    blockers: [{ _tag: "required-quarantined", dependency: dependency("target", "private") }],
  });
});

it.each([
  ["shared", "shared", true],
  ["private", "shared", true],
  ["private", "private", true],
  ["shared", "private", false],
] as const)("applies source declarations from %s to %s", (requesterOwner, targetOwner, allowed) => {
  const root = entry("root", {
    dependencies: [dependency("target", targetOwner)],
    owner: requesterOwner,
  });
  const target = entry("target", { activation: "opt-in", owner: targetOwner });

  const sources = [
    source("shared"),
    source("private", requesterOwner === "private" && targetOwner === "shared" ? ["shared"] : []),
  ];
  const result = resolve({ entries: [target, root], sources });

  if (allowed) {
    expect(selectedNames(result)).toContain(`${targetOwner}/target`);
  } else {
    expect(groupFor(result, "root")).toMatchObject({
      _tag: "blocked",
      blockers: [{ _tag: "required-source-undeclared" }],
    });
  }
});

it("blocks missing required commands and skips missing optional commands", () => {
  const command = { kind: "command", name: "review" } as const;
  const required = entry("root", { dependencies: [command] });
  const independent = entry("independent");
  const blocked = resolve({ entries: [required, independent] });
  expect(groupFor(blocked, "root")).toMatchObject({
    _tag: "blocked",
    blockers: [{ _tag: "required-missing", dependency: command }],
  });
  expect(selectedNames(blocked)).toEqual(["shared/independent"]);
  const optional = entry("optional", { dependencies: [{ ...command, optional: true }] });
  expect(selectedNames(resolve({ entries: [optional] }))).toEqual(["shared/optional"]);
  const requested = resolve({ entries: [optional], includeOptional: true });
  expect(groupFor(requested, "optional")).toMatchObject({ _tag: "selected" });
  expect(requested.optionalSkips).toMatchObject([
    { _tag: "optional-missing", dependency: command },
  ]);
});

it("treats required self and multi-node cycles as co-installation groups", () => {
  const self = entry("self", { dependencies: [dependency("self")] });
  const alpha = entry("alpha", { dependencies: [dependency("beta")] });
  const beta = entry("beta", {
    activation: "opt-in",
    dependencies: [dependency("alpha")],
  });

  const result = resolve({ entries: [beta, self, alpha] });

  expect(groupFor(result, "self")).toMatchObject({ _tag: "selected", members: [address("self")] });
  expect(groupFor(result, "alpha")).toMatchObject({
    _tag: "selected",
    members: [address("alpha"), address("beta")],
  });
});

it("blocks a whole required cycle when an external requirement fails", () => {
  const alpha = entry("alpha", { dependencies: [dependency("beta")] });
  const beta = entry("beta", {
    activation: "opt-in",
    dependencies: [dependency("alpha"), dependency("missing")],
  });

  const result = resolve({ entries: [alpha, beta] });

  expect(groupFor(result, "alpha")).toMatchObject({
    _tag: "blocked",
    blockers: [{ _tag: "required-missing", requester: address("beta") }],
    members: [address("alpha"), address("beta")],
  });
  expect(selectedNames(result)).toEqual([]);
});

it("propagates blockers backward and prunes healthy branches of blocked requesters", () => {
  const alpha = entry("alpha", {
    dependencies: [dependency("broken"), dependency("healthy")],
  });
  const broken = entry("broken", {
    activation: "opt-in",
    dependencies: [dependency("missing")],
  });
  const healthy = entry("healthy", { activation: "opt-in" });

  const result = resolve({ entries: [healthy, broken, alpha] });

  expect(groupFor(result, "alpha")).toMatchObject({
    _tag: "blocked",
    blockers: [{ _tag: "required-missing", requester: address("broken") }],
  });
  expect(groupFor(result, "broken")).toMatchObject({ _tag: "blocked" });
  expect(groupFor(result, "healthy")).toBeUndefined();
});

it("retains a shared dependency reached by an independent healthy requester", () => {
  const broken = entry("broken", {
    dependencies: [dependency("missing"), dependency("shared-dependency")],
  });
  const healthy = entry("healthy", { dependencies: [dependency("shared-dependency")] });
  const sharedDependency = entry("shared-dependency", { activation: "opt-in" });

  const result = resolve({ entries: [sharedDependency, broken, healthy] });

  expect(groupFor(result, "broken")?._tag).toBe("blocked");
  expect(selectedNames(result)).toEqual(["shared/healthy", "shared/shared-dependency"]);
});

it("retains a healthy dependency that is independently selected despite a blocked requester", () => {
  const broken = entry("broken", {
    dependencies: [dependency("missing"), dependency("independent")],
  });
  const independent = entry("independent");

  const result = resolve({ entries: [independent, broken] });

  expect(groupFor(result, "broken")?._tag).toBe("blocked");
  expect(selectedNames(result)).toEqual(["shared/independent"]);
});

it("ignores optional edges unless requested", () => {
  const root = entry("root", { dependencies: [dependency("optional", "shared", true)] });
  const optional = entry("optional", { activation: "opt-in" });

  const result = resolve({ entries: [optional, root] });

  expect(selectedNames(result)).toEqual(["shared/root"]);
  expect(result.optionalSkips).toEqual([]);
});

it("recursively includes usable optional groups without merging optional cycles", () => {
  const root = entry("root", { dependencies: [dependency("alpha", "shared", true)] });
  const alpha = entry("alpha", {
    activation: "opt-in",
    dependencies: [dependency("beta", "shared", true)],
    projects: ["another-project"],
  });
  const beta = entry("beta", {
    activation: "opt-in",
    dependencies: [dependency("alpha", "shared", true)],
    projects: ["another-project"],
  });

  const result = resolve({
    entries: [beta, root, alpha],
    includeOptional: true,
    namespace: projectNamespace,
  });

  expect(selectedNames(result)).toEqual(["shared/alpha", "shared/beta", "shared/root"]);
  expect(groupFor(result, "alpha")?.members).toEqual([address("alpha")]);
  expect(groupFor(result, "beta")?.members).toEqual([address("beta")]);
  expect(result.optionalSkips).toEqual([]);
});

it.each([
  ["optional-missing", [], [], "shared", false],
  ["optional-quarantined", [], [quarantine(address("target"))], "shared", false],
  ["optional-excluded", [choice(address("target"), "exclude")], [], "shared", true],
  ["optional-source-undeclared", [], [], "private", true],
] as const)(
  "skips an unusable optional edge as %s without blocking its requester",
  (code, choices, quarantined, targetOwner, includeTarget) => {
    const root = entry("root", {
      dependencies: [dependency("target", targetOwner, true)],
    });
    const target = entry("target", { activation: "opt-in", owner: targetOwner });
    const entries = includeTarget ? [target, root] : [root];

    const result = resolve({
      choices,
      entries,
      includeOptional: true,
      quarantined,
      sources: [source("shared"), source("private")],
    });

    expect(selectedNames(result)).toEqual(["shared/root"]);
    expect(result.optionalSkips).toMatchObject([
      { _tag: code, dependency: dependency("target", targetOwner), requester: address("root") },
    ]);
  },
);

it("skips an optional target with broken required closure", () => {
  const root = entry("root", { dependencies: [dependency("optional", "shared", true)] });
  const optional = entry("optional", {
    activation: "opt-in",
    dependencies: [dependency("missing")],
  });

  const result = resolve({ entries: [optional, root], includeOptional: true });

  expect(selectedNames(result)).toEqual(["shared/root"]);
  expect(result.optionalSkips).toMatchObject([
    {
      _tag: "optional-required-closure-blocked",
      blockers: [{ _tag: "required-missing", requester: address("optional") }],
      dependency: dependency("optional"),
      requester: address("root"),
    },
  ]);
});

it.each([
  ["requested-missing", []],
  ["requested-quarantined", [quarantine(address("unresolved"))]],
] as const)("surfaces an unresolved explicit include as %s", (code, quarantined) => {
  const unresolved = address("unresolved");

  const result = resolve({
    choices: [choice(unresolved, "include")],
    entries: [],
    quarantined,
  });

  expect(result.requestBlockers).toEqual([{ _tag: code, address: unresolved }]);
});

it("normalizes input permutations and round-trips its JSON-safe schema", () => {
  const root = entry("root", {
    dependencies: [dependency("required"), dependency("optional", "shared", true)],
  });
  const required = entry("required", { activation: "opt-in" });
  const optional = entry("optional", { activation: "opt-in" });
  const input = [root, required, optional];
  const forward = resolve({ entries: input, includeOptional: true });
  const reversed = resolve({ entries: [...input].reverse(), includeOptional: true });

  expect(reversed).toEqual(forward);
  expect(
    Schema.decodeUnknownSync(DependencyResolutionSchema)(JSON.parse(JSON.stringify(forward))),
  ).toEqual(forward);
  expect(selectedDependencyAddresses(forward)).toEqual(
    forward.groups.flatMap((group) => (group._tag === "selected" ? group.members : [])),
  );
});

const thirdId = "00000000-0000-4000-8000-000000000003";
const fourthId = "00000000-0000-4000-8000-000000000004";

const entryIn = (
  name: string,
  registrationId: string,
  dependencies: SkillCatalogEntry["dependencies"] = [],
  activation: SkillCatalogEntry["activation"] = "opt-in",
) =>
  ({
    activation,
    userActivation: activation,
    address: { kind: "skill", name, sourceRegistrationId: registrationId },
    dependencies,
    description: `${name} description`,
    directoryPath: `/sources/${registrationId}/${name}`,
    frontmatter: { description: `${name} description`, name },
    projects: [],
    skillFilePath: `/sources/${registrationId}/${name}/SKILL.md`,
    sourcePath: `/sources/${registrationId}`,
    sourceRegistrationId: registrationId,
  }) satisfies SkillCatalogEntry;

const sourceAt = (
  registrationId: string,
  label: string,
  options: {
    readonly dependsOn?: ReadonlyArray<string>;
    readonly bundle?: { readonly identity: string; readonly bindings: Record<string, string> };
    readonly origin?: "builtin" | "bundle";
  } = {},
): NonNullable<Catalog["sources"]>[number] => ({
  registration: {
    id: registrationId,
    canonicalPath: `/sources/${registrationId}`,
    ...(options.bundle === undefined
      ? {}
      : {
          bundle: {
            identity: options.bundle.identity,
            sourceKey: label,
            bindings: options.bundle.bindings,
            sourceKeys: {},
            files: [],
          },
        }),
  },
  status: "healthy",
  label,
  labelOrigin: "declared",
  dependsOn: options.dependsOn ?? [],
  ...(options.origin === undefined ? {} : { origin: options.origin }),
});

const sharedId = address("x").sourceRegistrationId;
const privateId = address("x", "private").sourceRegistrationId;
const bundleIdentity = "a".repeat(64);

it.each([
  ["its own label", "shared", {}],
  ["its own registration ID", sharedId, {}],
  ["a bundle binding that points back at itself", "alias", { bindings: { alias: sharedId } }],
] as const)(
  "resolves a dependency that names %s as its source to the requester's own source",
  (_case, sourceName, bundle) => {
    const root = entryIn(
      "root",
      sharedId,
      [{ kind: "skill", name: "target", source: sourceName }],
      "default",
    );
    const target = entryIn("target", sharedId);
    const sources = [
      sourceAt(
        sharedId,
        "shared",
        "bindings" in bundle
          ? { bundle: { identity: bundleIdentity, bindings: bundle.bindings } }
          : {},
      ),
    ];

    const result = resolve({ entries: [target, root], sources });

    expect(groupFor(result, "root")).toMatchObject({ _tag: "selected" });
    expect(selectedDependencyAddresses(result)).toEqual([root.address, target.address]);
  },
);

it.each([
  ["its own source", "shared", thirdId, ["helpers"]],
  ["a declared source", "helpers", sharedId, ["helpers"]],
  ["its own source while a declared label is absent", "shared", thirdId, ["helpers", "absent"]],
] as const)(
  "reports a dependency pinned to %s as missing when only another source provides it",
  (_case, sourceName, providerId, dependsOn) => {
    const root = entryIn(
      "root",
      sharedId,
      [{ kind: "skill", name: "target", source: sourceName }],
      "default",
    );

    const result = resolve({
      entries: [root, entryIn("target", providerId)],
      sources: [sourceAt(sharedId, "shared", { dependsOn }), sourceAt(thirdId, "helpers")],
    });

    expect(groupFor(result, "root")).toMatchObject({
      _tag: "blocked",
      blockers: [{ _tag: "required-missing", requester: root.address }],
    });
  },
);

it("lists every edge, required or optional, that names no single resource, with its position", () => {
  const root = entryIn(
    "root",
    sharedId,
    [
      { kind: "skill", name: "target" },
      { kind: "skill", name: "absent", optional: true },
      { kind: "skill", name: "target", source: "elsewhere" },
      { kind: "command", name: "broken" },
      { kind: "skill", name: "twin" },
    ],
    "default",
  );
  const context = {
    address: { kind: "context", name: "notes.md", sourceRegistrationId: sharedId },
    directoryPath: "/sources/shared",
    filePath: "/sources/shared/notes.md",
    sourcePath: "/sources/shared",
    sourceRegistrationId: sharedId,
  } satisfies Extract<SelectableCatalogEntry, { readonly address: { readonly kind: "context" } }>;

  const edges = unresolvedDependencyEdges({
    entries: [
      root,
      context,
      entryIn("target", sharedId),
      entryIn("twin", thirdId),
      entryIn("twin", fourthId),
    ],
    quarantined: [
      {
        address: { kind: "command", name: "broken", sourceRegistrationId: sharedId },
        code: "command-metadata-invalid",
        directoryPath: "/sources/shared",
        filePath: "/sources/shared/broken.md",
        message: "invalid",
        sourcePath: "/sources/shared",
        sourceRegistrationId: sharedId,
      },
    ],
    sources: [
      sourceAt(sharedId, "shared", { dependsOn: ["left", "right"] }),
      sourceAt(thirdId, "left"),
      sourceAt(fourthId, "right"),
    ],
  });

  expect(
    edges.map(({ requester, position, failure }) => [
      requester.address.name,
      position,
      failure.reason,
    ]),
  ).toEqual([
    ["root", 1, "missing"],
    ["root", 2, "source-undeclared"],
    ["root", 3, "quarantined"],
    ["root", 4, "ambiguous"],
  ]);
});

it("names the declared labels no source carries, and the sources an undeclared edge would need", () => {
  const { label: _label, ...noLabel } = sourceAt(fourthId, "unused");
  const unlistedId = "00000000-0000-4000-8000-000000000005";

  const edges = unresolvedDependencyEdges({
    entries: [
      entryIn(
        "root",
        sharedId,
        [
          { kind: "skill", name: "target" },
          { kind: "skill", name: "target", source: "ghost" },
        ],
        "default",
      ),
      entryIn("lone", privateId, [{ kind: "skill", name: "audit" }], "default"),
      entryIn("audit", thirdId),
      entryIn("audit", fourthId),
      entryIn("audit", unlistedId),
    ],
    quarantined: [],
    sources: [
      sourceAt(sharedId, "shared", { dependsOn: ["ghost", "phantom"] }),
      sourceAt(privateId, "private"),
      sourceAt(thirdId, "elsewhere"),
      noLabel,
    ],
  });

  expect(edges.map(({ failure }) => failure)).toEqual([
    { reason: "source-unregistered", labels: ["ghost", "phantom"] },
    { reason: "source-unregistered", labels: ["ghost"] },
    {
      reason: "source-undeclared",
      providers: [`/sources/${fourthId}`, unlistedId, "elsewhere"],
    },
  ]);
});

it("lists an unresolved edge of a catalog that reports no sources", () => {
  const edges = unresolvedDependencyEdges({
    entries: [entry("root", { dependencies: [dependency("absent")] })],
    quarantined: [],
  });

  expect(edges.map(({ position, failure }) => [position, failure.reason])).toEqual([
    [0, "missing"],
  ]);
});

it("blocks a dependency on a declared source label that no registered source carries", () => {
  const root = entryIn(
    "root",
    sharedId,
    [{ kind: "skill", name: "target", source: "absent" }],
    "default",
  );

  const result = resolve({
    entries: [root],
    sources: [sourceAt(sharedId, "shared", { dependsOn: ["absent"] })],
  });

  expect(groupFor(result, "root")).toMatchObject({
    _tag: "blocked",
    blockers: [{ _tag: "required-source-unregistered", requester: root.address }],
  });
});

it("blocks a dependency on a declared source label that two registered sources carry", () => {
  const root = entryIn(
    "root",
    sharedId,
    [{ kind: "skill", name: "target", source: "twin" }],
    "default",
  );
  const first = entryIn("target", thirdId);
  const second = entryIn("target", fourthId);

  const result = resolve({
    entries: [root, first, second],
    sources: [
      sourceAt(sharedId, "shared", { dependsOn: ["twin"] }),
      sourceAt(thirdId, "twin"),
      sourceAt(fourthId, "twin"),
    ],
  });

  expect(groupFor(result, "root")).toMatchObject({
    _tag: "blocked",
    blockers: [{ _tag: "required-ambiguous", requester: root.address }],
  });
});

it("blocks an unqualified dependency that two declared sources both provide", () => {
  const root = entryIn("root", sharedId, [{ kind: "skill", name: "target" }], "default");

  const result = resolve({
    entries: [root, entryIn("target", thirdId), entryIn("target", fourthId)],
    sources: [
      sourceAt(sharedId, "shared", { dependsOn: ["left", "right"] }),
      sourceAt(thirdId, "left"),
      sourceAt(fourthId, "right"),
    ],
  });

  expect(groupFor(result, "root")).toMatchObject({
    _tag: "blocked",
    blockers: [{ _tag: "required-ambiguous", requester: root.address }],
  });
});

it("reports an unqualified missing dependency as unregistered when a declared source is absent", () => {
  const root = entryIn("root", sharedId, [{ kind: "skill", name: "target" }], "default");

  const result = resolve({
    entries: [root],
    sources: [sourceAt(sharedId, "shared", { dependsOn: ["absent"] })],
  });

  expect(groupFor(result, "root")).toMatchObject({
    _tag: "blocked",
    blockers: [{ _tag: "required-source-unregistered", requester: root.address }],
  });
});

/** A registered source whose declaration Tack cannot read, so its label is unknown. */
const unhealthySourceAt = (registrationId: string): NonNullable<Catalog["sources"]>[number] => ({
  issue: { code: "declaration-schema-invalid", message: "invalid" },
  registration: { id: registrationId, canonicalPath: `/sources/${registrationId}` },
  status: "unhealthy",
});

it.each([
  ["names the source", [{ kind: "skill", name: "target", source: "helpers" }]],
  ["leaves the source unnamed", [{ kind: "skill", name: "target" }]],
] as const)(
  "reports a dependency that %s as from an unhealthy source when a registered source cannot be read",
  (_case, dependencies) => {
    const root = entryIn("root", sharedId, dependencies, "default");

    const result = resolve({
      entries: [root],
      sources: [
        sourceAt(sharedId, "shared", { dependsOn: ["helpers"] }),
        unhealthySourceAt(fourthId),
        unhealthySourceAt(thirdId),
      ],
    });

    expect(groupFor(result, "root")).toMatchObject({
      _tag: "blocked",
      blockers: [
        {
          _tag: "required-source-unhealthy",
          requester: root.address,
          unhealthySources: [`/sources/${thirdId}`, `/sources/${fourthId}`],
        },
      ],
    });
  },
);

it("skips an optional dependency whose source cannot be read as from an unhealthy source", () => {
  const root = entryIn(
    "root",
    sharedId,
    [{ kind: "skill", name: "target", source: "helpers", optional: true }],
    "default",
  );

  const result = resolve({
    entries: [root],
    includeOptional: true,
    sources: [sourceAt(sharedId, "shared", { dependsOn: ["helpers"] }), unhealthySourceAt(thirdId)],
  });

  expect(result.optionalSkips).toEqual([
    {
      _tag: "optional-source-unhealthy",
      dependency: { kind: "skill", name: "target", source: "helpers", optional: true },
      requester: root.address,
      unhealthySources: [`/sources/${thirdId}`],
    },
  ]);
});

it("resolves a bundled source's declared label through its bundle bindings", () => {
  const otherBundle = "b".repeat(64);
  const root = entryIn(
    "root",
    sharedId,
    [{ kind: "skill", name: "target", source: "helper" }],
    "default",
  );
  const bound = entryIn("target", thirdId);
  const foreign = entryIn("target", fourthId);

  const result = resolve({
    entries: [root, bound, foreign],
    sources: [
      sourceAt(sharedId, "shared", {
        dependsOn: ["helper"],
        bundle: { identity: bundleIdentity, bindings: { helper: thirdId } },
      }),
      sourceAt(thirdId, "helper", { bundle: { identity: bundleIdentity, bindings: {} } }),
      sourceAt(fourthId, "helper", { bundle: { identity: otherBundle, bindings: {} } }),
    ],
  });

  expect(selectedDependencyAddresses(result)).toEqual([root.address, bound.address]);
});

it("prefers a healthy built-in source over a registered source with the same label", () => {
  const root = entryIn(
    "root",
    sharedId,
    [{ kind: "skill", name: "target", source: "tack" }],
    "default",
  );
  const builtin = entryIn("target", thirdId);
  const registered = entryIn("target", fourthId);

  const result = resolve({
    entries: [root, builtin, registered],
    sources: [
      sourceAt(sharedId, "shared", { dependsOn: ["tack"] }),
      sourceAt(thirdId, "tack", { origin: "builtin" }),
      sourceAt(fourthId, "tack"),
    ],
  });

  expect(selectedDependencyAddresses(result)).toEqual([root.address, builtin.address]);
});

it("keeps one blocked group when two selected requesters share its failure", () => {
  const left = entry("left", { dependencies: [dependency("broken")] });
  const right = entry("right", { dependencies: [dependency("broken")] });
  const broken = entry("broken", { activation: "opt-in", dependencies: [dependency("missing")] });

  const result = resolve({ entries: [left, right, broken] });

  expect(result.groups.map((group) => [group._tag, group.members.map(({ name }) => name)])).toEqual(
    [
      ["blocked", ["broken"]],
      ["blocked", ["left"]],
      ["blocked", ["right"]],
    ],
  );
});

it("walks several optional dependencies in kind and name order", () => {
  const root = entry("root", {
    dependencies: [
      dependency("zeta", "shared", true),
      { kind: "command", name: "absent", optional: true },
      dependency("alpha", "shared", true),
    ],
  });

  const result = resolve({ entries: [root], includeOptional: true });

  expect(result.optionalSkips.map((skip) => [skip._tag, skip.dependency.name])).toEqual([
    ["optional-missing", "absent"],
    ["optional-missing", "alpha"],
    ["optional-missing", "zeta"],
  ]);
});

it("blocks a dependency naming a source its requester never declared", () => {
  const root = entryIn(
    "root",
    sharedId,
    [{ kind: "skill", name: "target", source: "elsewhere" }],
    "default",
  );

  const result = resolve({
    entries: [root, entryIn("target", thirdId)],
    sources: [sourceAt(sharedId, "shared"), sourceAt(thirdId, "elsewhere")],
  });

  expect(groupFor(result, "root")).toMatchObject({
    _tag: "blocked",
    blockers: [{ _tag: "required-source-undeclared", requester: root.address }],
  });
});

it("selects an included context entry, which carries no dependencies, as its own group", () => {
  const context = {
    address: { kind: "context", name: "notes.md", sourceRegistrationId: sharedId },
    directoryPath: "/sources/shared",
    filePath: "/sources/shared/notes.md",
    sourcePath: "/sources/shared",
    sourceRegistrationId: sharedId,
  } satisfies Extract<SelectableCatalogEntry, { readonly address: { readonly kind: "context" } }>;

  const result = resolveDependencyClosure({
    entries: [context],
    includeOptional: true,
    initialSelection: resolveInitialSelection({
      choices: [{ address: context.address, decision: "include", namespace: userNamespace }],
      entries: [context],
      namespace: userNamespace,
    }),
    quarantined: [],
  });

  expect(result).toEqual({
    groups: [{ _tag: "selected", members: [context.address] }],
    optionalSkips: [],
    requestBlockers: [],
  });
});

it("ignores quarantine diagnostics that carry no address", () => {
  const root = entry("root", { dependencies: [dependency("target")] });
  const { address: _address, ...addressless } = quarantine(address("target"));

  const result = resolve({ entries: [root], quarantined: [addressless] });

  expect(groupFor(result, "root")).toMatchObject({
    blockers: [{ _tag: "required-missing", requester: address("root") }],
  });
});

it("raises no request blocker for an unresolved exclude choice", () => {
  const result = resolve({ choices: [choice(address("gone"), "exclude")], entries: [] });

  expect(result.requestBlockers).toEqual([]);
  expect(resolutionIsUnresolved(result)).toBe(false);
});

it.each([
  ["a request blocker", { choices: [choice(address("gone"), "include")], entries: [] }, true],
  [
    "a blocked group",
    { entries: [entry("root", { dependencies: [dependency("missing")] })] },
    true,
  ],
  ["only selected groups", { entries: [entry("root")] }, false],
] as const)("reports a resolution with %s as unresolved: %s", (_case, input, unresolved) => {
  expect(resolutionIsUnresolved(resolve(input))).toBe(unresolved);
});
