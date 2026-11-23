import { Yaml } from "../../domain/runtime-neutral.ts";
import {
  builtinProfileOmissionNote,
  profileControlledAddresses,
} from "../../domain/profiles/profile-policy.ts";
import { profileDeliveryCollisions } from "../../domain/profiles/inventory-collisions.ts";
import { Effect, FileSystem, Path, Schema } from "effect";
import type { ResourceKind } from "../../domain/resources/kinds.ts";
import {
  ChoiceNamespaceSchema,
  choiceNamespaceIdentity,
  type ChoiceNamespace,
  type SkillChoice,
} from "../../domain/choices/choice-schema.ts";
import {
  resolutionIsUnresolved,
  selectedDependencyAddresses,
  type DependencyResolution,
} from "../../domain/choices/dependency-resolution.ts";
import {
  profileApplicationFor,
  resolveContextSelection,
} from "../../domain/profiles/profile-application.ts";
import { resolveProfile } from "../../domain/profiles/profile-resolution.ts";
import { portableProfile } from "../../domain/profiles/portable-profile.ts";
import { publishProfileText } from "../../domain/profiles/publication-text.ts";
import {
  ResourceAddressSchema,
  SelectableAddressSchema,
  isSelectableAddress,
  resourceAddressIdentity,
  type ResourceAddress,
  type SelectableAddress,
} from "../../domain/sources/catalog-schema.ts";
import {
  allSkillChoices,
  docsSettingsFor,
  withDocsSettings,
} from "../../domain/state/state-intent.ts";
import { withChoice, requireChoiceNamespace } from "../choices/choice.ts";
import { profileContext } from "./profile-check.ts";
import { readProfileFile } from "../sources/profile-files.ts";
import { profilePublications } from "../sources/profile-publications.ts";
import { saveProfile } from "./profile-save.ts";
import { readRegisteredProfile } from "./profile-reference.ts";
import {
  makeCommandSnapshot,
  readInvocationSnapshot,
  writerInvocationSnapshot,
  type CommandSnapshot,
} from "../snapshot/command-snapshot.ts";
import { planSync } from "../reconciliation/sync-command.ts";
import { withStateCheckpointWriter, type StateOptions } from "../../services/state-store.ts";
import {
  ProfilePlanFindingSchema,
  type ProfilePlanFinding,
} from "../../domain/profiles/profile-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";
import { readDeclarationText } from "../sources/declaration-file.ts";
import { sourceFileFailure } from "../sources/source.ts";

/** Explicit copy composition: user, one named project, or both; never every project. */
const ProfileCopyInputSchema = Schema.Struct({
  user: Schema.Boolean,
  projectName: Schema.optionalKey(Schema.String),
});
export type ProfileCopyInput = typeof ProfileCopyInputSchema.Type;

/** One copied member, with every selection level it was copied from. */
const ProfileCopyMemberSchema = Schema.Struct({
  address: ResourceAddressSchema,
  origins: Schema.Array(Schema.String),
});
export type ProfileCopyMember = typeof ProfileCopyMemberSchema.Type;

/**
 * The `profile save` plan payload: the copied members, the profile file and publication text
 * before and after, the membership diff against the published profile, and why it refuses.
 */
export const ProfileSavePlanSchema = Schema.Struct({
  kind: Schema.Literal("profile-save"),
  input: ProfileCopyInputSchema,
  members: Schema.Array(ProfileCopyMemberSchema),
  notes: Schema.Array(Schema.String),
  file: Schema.String,
  profileBefore: Schema.String,
  profileAfter: Schema.String,
  publicationBefore: Schema.String,
  publicationAfter: Schema.String,
  findings: Schema.Array(ProfilePlanFindingSchema),
  added: Schema.Array(ResourceAddressSchema),
  removed: Schema.Array(ResourceAddressSchema),
});
type ProfileSavePlan = typeof ProfileSavePlanSchema.Type;

/**
 * The `profile adopt` plan payload: the choices it includes and docs it attaches in the daily
 * selection, the ordinary blockers that remain, and why it refuses.
 */
export const ProfileAdoptPlanSchema = Schema.Struct({
  kind: Schema.Literal("profile-adopt"),
  reference: Schema.String,
  namespace: ChoiceNamespaceSchema,
  includes: Schema.Array(SelectableAddressSchema),
  attachments: Schema.Array(ResourceAddressSchema),
  notes: Schema.Array(Schema.String),
  blockers: Schema.Array(Schema.String),
  findings: Schema.Array(ProfilePlanFindingSchema),
});
type ProfileAdoptPlan = typeof ProfileAdoptPlanSchema.Type;

/**
 * Each identity that keeps a selection from copying whole, with why: a pick of a resource no source
 * provides, or a member whose required dependency is blocked.
 */
const unresolvedIdentities = (
  unresolvedChoices: ReadonlyArray<SkillChoice>,
  resolution: DependencyResolution,
): ReadonlyArray<string> => [
  ...new Set([
    ...resolution.requestBlockers.map(
      ({ _tag, address }) => `${address.kind} ${address.name} (${_tag.replace("requested-", "")})`,
    ),
    ...unresolvedChoices
      .filter((choice) => choice.decision === "exclude")
      .map(({ address }) => `${address.kind} ${address.name} (excluded but missing)`),
    ...resolution.groups.flatMap((group) =>
      group._tag === "blocked"
        ? group.blockers.map(
            ({ _tag, dependency, requester }) =>
              `${requester.kind} ${requester.name} needs ${dependency.kind} ${dependency.name} (${_tag.replace("required-", "")})`,
          )
        : [],
    ),
  ]),
];

/** Resolves independent input levels, folding exact identities while retaining every origin. */
export const collectProfileInput = Effect.fnUntraced(function* (
  snapshot: CommandSnapshot,
  input: ProfileCopyInput,
) {
  const catalog = yield* snapshot.catalog;
  const findings: ProfilePlanFinding[] = [];
  const levels: ChoiceNamespace[] = [
    ...(input.user ? [{ _tag: "user" as const }] : []),
    ...(input.projectName === undefined
      ? []
      : [{ _tag: "project" as const, projectName: input.projectName }]),
  ];
  if (levels.length === 0)
    findings.push({
      code: "profile-copy-input",
      message: "Choose user, one named project, or user + one project.",
    });
  const members = new Map<string, { address: ResourceAddress; origins: string[] }>();
  for (const namespace of levels) {
    const origin = namespace._tag === "user" ? "user" : `project ${namespace.projectName}`;
    const project =
      namespace._tag === "project"
        ? snapshot.state.data.projects.find((entry) => entry.name === namespace.projectName)
        : undefined;
    if (
      namespace._tag === "project" &&
      (project === undefined || project.removalIntent !== undefined)
    ) {
      findings.push({
        code: "profile-copy-input",
        message: `Choose a registered active project; ${origin} is unavailable.`,
      });
      continue;
    }
    if (profileApplicationFor(snapshot.state, namespace) !== undefined) {
      findings.push({
        code: "profile-copy-input-fixed",
        message: `${origin} is fixed. Save from ordinary daily selection in a separate context.`,
      });
      continue;
    }
    const selected = resolveContextSelection(snapshot.state, catalog, namespace, false);
    if (
      selected.selection.unresolvedChoices.length > 0 ||
      resolutionIsUnresolved(selected.resolution)
    )
      findings.push({
        code: "profile-copy-input-unresolved",
        message: `${origin} has missing or blocked identities: ${unresolvedIdentities(selected.selection.unresolvedChoices, selected.resolution).join(", ")}. Restore their sources/members or repair picks before saving; nothing is silently omitted.`,
      });
    const addresses: ResourceAddress[] = [
      ...selectedDependencyAddresses(selected.resolution),
      ...(project?.docs?.attachments ?? []).map((resource) => ({
        ...resource,
        kind: "docs" as const,
      })),
    ];
    for (const address of profileControlledAddresses(catalog, addresses)) {
      const identity = resourceAddressIdentity(address);
      if (catalog.entries.every((entry) => resourceAddressIdentity(entry.address) !== identity))
        findings.push({
          code: "profile-copy-input-unresolved",
          message: `${origin}: ${address.kind} ${address.name} is unavailable. Repair its source before saving.`,
        });
      const existing = members.get(identity);
      if (existing === undefined) members.set(identity, { address, origins: [origin] });
      else existing.origins.push(origin);
    }
  }
  findings.push(
    ...profileDeliveryCollisions([...members.values()].map((member) => member.address)).map(
      (name) => ({
        code: "profile-copy-collision",
        message: `${name} has conflicting owning sources in the chosen levels. Explicitly narrow membership; no winner is chosen.`,
      }),
    ),
  );
  return {
    input,
    members: [...members.values()] as ReadonlyArray<ProfileCopyMember>,
    findings,
    notes: [builtinProfileOmissionNote],
  };
});

/** Previews source file/publication changes and saves only after explicit acceptance. */
export const runProfileSaveSelection = Effect.fn("profiles.runProfileSaveSelection")(
  function* (
    options: StateOptions,
    request: {
      readonly input: ProfileCopyInput;
      readonly sourcePath: string;
      readonly name: string;
      readonly edit: boolean;
      readonly apply: boolean;
    },
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const snapshot = yield* readInvocationSnapshot(options);
    const input = yield* collectProfileInput(snapshot, request.input);
    const context = yield* profileContext(options, request.sourcePath);
    const portable = portableProfile(
      request.name,
      context.registration.id,
      input.members.map((member) => member.address),
      context.catalog,
    );
    const published = profilePublications(context.source.canonicalPath, context.source.declaration);
    const publication = published.publications.find((entry) => entry.name === request.name);
    const findings = [...input.findings, ...portable.findings, ...published.findings];
    if (context.registration.bundle !== undefined)
      findings.push({
        code: "profile-bundle-immutable",
        message:
          "Choose an authored source for save. Verified bundle projections retain immutable artifact bytes.",
      });
    if (publication !== undefined && request.edit === false)
      findings.push({
        code: "profile-copy-edit-required",
        message:
          "This profile is already published. Choose its explicit edit entry or use --edit after reviewing its membership diff.",
      });
    const file = path.join(
      context.source.canonicalPath,
      publication?.path ?? `profiles/${request.name}.yaml`,
    );
    const profileBefore = publication === undefined ? "" : yield* fs.readFileString(file);
    const profileAfter = `${Yaml.stringify(portable.profile).trimEnd()}\n`;
    const publicationBefore = yield* readDeclarationText(context.source.canonicalPath);
    const publicationAfter =
      publication === undefined
        ? (publishProfileText(publicationBefore, [
            ...published.publications,
            { name: request.name, path: `profiles/${request.name}.yaml` },
          ]).text ?? publicationBefore)
        : publicationBefore;
    const previous =
      publication === undefined
        ? undefined
        : yield* readProfileFile(
            context.source.canonicalPath,
            context.source.declaration,
            publication,
          );
    const prior =
      previous?.profile === undefined
        ? []
        : resolveProfile(previous.profile, context.registration.id, context.catalog, file).direct;
    const nextKeys = new Set(
      input.members.map((member) => resourceAddressIdentity(member.address)),
    );
    const priorKeys = new Set(prior.map(resourceAddressIdentity));
    const plan: ProfileSavePlan = {
      kind: ProfileSavePlanSchema.fields.kind.literal,
      input: request.input,
      members: input.members,
      notes: input.notes,
      file,
      profileBefore,
      profileAfter,
      publicationBefore,
      publicationAfter,
      findings,
      added: input.members.flatMap((member) =>
        priorKeys.has(resourceAddressIdentity(member.address)) ? [] : [member.address],
      ),
      removed: prior.filter((address) => nextKeys.has(resourceAddressIdentity(address)) === false),
    };
    if (request.apply === false || findings.length > 0) return { plan, saved: false };
    const result = yield* saveProfile(options, {
      sourcePath: context.source.canonicalPath,
      profile: portable.profile,
      ...(publication === undefined ? {} : { expectedContent: profileBefore }),
    });
    return {
      plan: {
        ...plan,
        findings: result.report.findings.filter((finding) => finding.severity === "error"),
      },
      saved: result.saved,
    };
  },
  (effect, _options, request) =>
    effect.pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(sourceFileFailure("save profile", request.sourcePath)(error)),
      ),
    ),
);

export type ProfileAdoptRequest = {
  readonly reference: string;
  readonly namespace: ChoiceNamespace;
  readonly apply: boolean;
  readonly cwd: string;
};

/** What adoption says about a kind it copies without a managed link; nothing for linked kinds. */
const adoptionNotes: Readonly<Record<ResourceKind, ((name: string) => string) | undefined>> = {
  skill: undefined,
  command: undefined,
  context: (name) => `Context ${name}: ordinary selection role; no adapter link.`,
  script: (name) => `Script ${name}: explicit run only; no pick, attachment or execution.`,
  docs: undefined,
};

const planAdoption = Effect.fnUntraced(function* (
  options: StateOptions,
  request: ProfileAdoptRequest,
  snapshot: CommandSnapshot,
) {
  const findings: ProfilePlanFinding[] = [];
  const base = {
    kind: ProfileAdoptPlanSchema.fields.kind.literal,
    reference: request.reference,
    namespace: request.namespace,
    includes: [] as ReadonlyArray<SelectableAddress>,
    attachments: [] as ReadonlyArray<ResourceAddress>,
    notes: [] as ReadonlyArray<string>,
    blockers: [] as ReadonlyArray<string>,
  };
  yield* requireChoiceNamespace(snapshot.state, request.namespace);
  if (profileApplicationFor(snapshot.state, request.namespace) !== undefined)
    return {
      state: snapshot.state,
      plan: {
        ...base,
        findings: [
          {
            code: "profile-fixed-context",
            message:
              "This context has a fixed application. Choose a separate daily-selection context; adoption cannot write ignored ordinary choices.",
          },
        ],
      } satisfies ProfileAdoptPlan,
    };
  const loaded = yield* readRegisteredProfile(snapshot, request.reference);
  findings.push(...loaded.findings);
  if (loaded.resolved === undefined || findings.length > 0)
    return { state: snapshot.state, plan: { ...base, findings } satisfies ProfileAdoptPlan };
  const { inventory } = loaded.resolved;
  const addresses = [
    ...new Map(
      [...inventory.direct, ...inventory.required].map((address) => [
        resourceAddressIdentity(address),
        address,
      ]),
    ).values(),
  ];
  const includes = addresses.filter(isSelectableAddress);
  const attachments = addresses.filter((address) => address.kind === "docs");
  if (attachments.length > 0 && request.namespace._tag === "user")
    findings.push({
      code: "profile-docs-require-project",
      message:
        "Docs require a project attachment. Choose a project before adoption; user-only copy cannot mount them.",
    });
  const copied = new Set(includes.map(resourceAddressIdentity));
  const namespaceKey = choiceNamespaceIdentity(request.namespace);
  const choices = allSkillChoices(snapshot.state).filter(
    (choice) =>
      choiceNamespaceIdentity(choice.namespace) !== namespaceKey ||
      copied.has(resourceAddressIdentity(choice.address)) === false,
  );
  let state: State = withChoice(snapshot.state, request.namespace, [
    ...choices,
    ...includes.map((address) => ({
      namespace: request.namespace,
      address,
      decision: "include" as const,
    })),
  ]);
  if (request.namespace._tag === "project") {
    const projectName = request.namespace.projectName;
    const settings = docsSettingsFor(state, projectName) ?? { projectName, attachments: [] };
    state = withDocsSettings(state, {
      ...settings,
      attachments: [
        ...new Map(
          [
            ...settings.attachments,
            ...attachments.map(({ name, sourceRegistrationId }) => ({
              name,
              sourceRegistrationId,
            })),
          ].map((address) => [`${address.sourceRegistrationId}:${address.name}`, address]),
        ).values(),
      ],
    });
  }
  const sync = yield* planSync(
    options,
    {
      apply: false,
      cwd: request.cwd,
      includeOptional: false,
      noDocs: false,
      selector: request.namespace,
    },
    yield* makeCommandSnapshot(state, snapshot),
  );
  const blockers = [
    ...(sync.resources?.causes ?? []).map((cause) => cause.code),
    ...sync.docs.flatMap((plan) => plan.issues.map((issue) => issue.code)),
  ];
  const notes = [
    ...inventory.findings
      .filter((finding) => finding.severity === "warning")
      .map((finding) => finding.message),
    "Copies ordinary positive choices and applicable docs attachments only. Unrelated picks remain; normal defaults and future edits still apply. No links are delivered.",
    ...addresses.flatMap((address) => {
      const note = adoptionNotes[address.kind];
      return note === undefined ? [] : [note(address.name)];
    }),
  ];
  return {
    state,
    plan: { ...base, includes, attachments, notes, blockers, findings } satisfies ProfileAdoptPlan,
  };
});

/** Copies profile content into ordinary intent once; never applies exact inventory or syncs. */
export const runProfileAdopt = Effect.fn("profiles.runProfileAdopt")(function* (
  options: StateOptions,
  request: ProfileAdoptRequest,
) {
  const preview = yield* planAdoption(options, request, yield* readInvocationSnapshot(options));
  if (request.apply === false || preview.plan.findings.length > 0)
    return { plan: preview.plan, adopted: false };
  return yield* withStateCheckpointWriter(options, (writer) =>
    Effect.gen(function* () {
      const current = yield* planAdoption(
        options,
        request,
        yield* writerInvocationSnapshot(writer.current()),
      );
      if (current.plan.findings.length > 0) return { plan: current.plan, adopted: false };
      yield* writer.checkpoint(() => Effect.succeed({ state: current.state, value: undefined }));
      return { plan: current.plan, adopted: true };
    }),
  );
});
