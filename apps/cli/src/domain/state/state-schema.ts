import { Result, Schema } from "effect";
import { ProfileApplicationSchema } from "./profile-application-schema.ts";
import { ChoiceDecisionSchema, choiceNamespaceIdentity } from "../choices/choice-schema.ts";
import { DocsDestinationSchema, DocsResourceReferenceSchema } from "../docs/docs-schema.ts";
import { ProjectPathSchema, ProjectRecordSchema } from "../projects/project-schema.ts";
import { SelectableAddressSchema } from "../sources/catalog-schema.ts";
import { SourceRegistrationSchema } from "../sources/source-schema.ts";
import { EnabledAdaptersSchema } from "../agents/agent-adapter-schema.ts";
import {
  LinkEvidenceSchema,
  LinkRecordsSchema,
  physicalDestinationIdentity,
} from "../links/link-record-schema.ts";
import { docsResourceIdentity } from "../docs/docs-schema.ts";
import { resourceAddressIdentity } from "../sources/catalog-schema.ts";
import { stateFormat } from "./state-format.ts";

// Project intent has the same nesting as the persisted document.

const ChoiceSchema = Schema.Struct({
  address: SelectableAddressSchema,
  decision: ChoiceDecisionSchema,
});

const ChoicesSchema = Schema.Array(ChoiceSchema).check(
  Schema.makeFilter((choices) =>
    new Set(choices.map((choice) => resourceAddressIdentity(choice.address))).size ===
    choices.length
      ? []
      : ["Resource choices must be unique within each namespace."],
  ),
);

const DocsAttachmentSchema = Schema.Struct({
  ...DocsResourceReferenceSchema.fields,
  writingDefault: Schema.optionalKey(Schema.Literal(true)),
});

const DocsSettingsSchema = Schema.Struct({
  attachments: Schema.Array(DocsAttachmentSchema),
  destination: Schema.optionalKey(DocsDestinationSchema),
}).check(
  Schema.makeFilter((settings) => {
    const identities = settings.attachments.map((attachment) => docsResourceIdentity(attachment));
    return [
      ...(new Set(identities).size === identities.length
        ? []
        : ["Docs attachments must be unique."]),
      ...(settings.attachments.filter((attachment) => attachment.writingDefault === true).length > 1
        ? ["Docs settings can have at most one explicit writing default."]
        : []),
    ];
  }),
);

const ProjectSchema = Schema.Struct({
  ...ProjectRecordSchema.fields,
  removingRoots: Schema.Array(ProjectPathSchema),
  choices: Schema.optionalKey(ChoicesSchema),
  docs: Schema.optionalKey(DocsSettingsSchema),
}).check(
  Schema.makeFilter((project) => {
    // The published record omits an empty handoff collection; the runtime always holds one.
    const { removingRoots, ...record } = project;
    const result = Schema.decodeUnknownResult(ProjectRecordSchema)(
      removingRoots.length === 0 ? record : { ...record, removingRoots },
    );
    return Result.isFailure(result) ? [result.failure.message] : [];
  }),
);

const SourceRegistrationsSchema = Schema.Array(SourceRegistrationSchema).check(
  Schema.makeFilter((registrations) => [
    ...(new Set(registrations.map((registration) => registration.id)).size === registrations.length
      ? []
      : ["Skill-source registration identities must be unique."]),
    ...(new Set(registrations.map((registration) => registration.canonicalPath)).size ===
    registrations.length
      ? []
      : ["Skill-source canonical paths must be unique."]),
  ]),
);

const ProjectRegistrationsSchema = Schema.Array(ProjectSchema).check(
  Schema.makeFilter((projects) => {
    const projectNames = projects.map((project) => project.name);
    const roots = projects.flatMap((project) => [...project.roots, ...project.removingRoots]);

    return [
      ...(new Set(projectNames).size === projectNames.length
        ? []
        : ["Project namespace names must be unique."]),
      ...(new Set(roots).size === roots.length
        ? []
        : ["Each canonical project root must have one owner."]),
    ];
  }),
);

/**
 * One prepared link action. Recovery stores only what it observes after a crash, independent of
 * the public action plan: the evidence for the link, and for a replacement the evidence it replaces.
 */
const JournalEntrySchema = Schema.Union([
  Schema.TaggedStruct("create", { link: LinkEvidenceSchema }),
  Schema.TaggedStruct("replace", { link: LinkEvidenceSchema, previous: LinkEvidenceSchema }),
  Schema.TaggedStruct("remove", { link: LinkEvidenceSchema }),
]);

/** One prepared state action. */
export type JournalEntry = typeof JournalEntrySchema.Type;

/**
 * The prepared actions of an apply. A document with nothing prepared has no journal, so a present
 * journal is never empty, and each destination appears at most once.
 */
const JournalSchema = Schema.Array(JournalEntrySchema).check(
  Schema.makeFilter((entries) => {
    const destinations = entries.map((entry) =>
      physicalDestinationIdentity(entry.link.destinationPath),
    );
    return [
      ...(entries.length > 0 ? [] : ["A document with nothing prepared has no journal."]),
      ...(new Set(destinations).size === destinations.length
        ? []
        : ["Each destination appears at most once in the journal."]),
    ];
  }),
);

/**
 * The central validated feature-data contract for Tack state. Every collection is always present,
 * except the journal that exists only while an action is prepared. Every link destination, agent
 * link or docs mount, has exactly one link record.
 */
const StateDataSchema = Schema.Struct({
  enabledAdapters: EnabledAdaptersSchema,
  userChoices: ChoicesSchema,
  links: LinkRecordsSchema,
  journal: Schema.optionalKey(JournalSchema),
  projects: ProjectRegistrationsSchema,
  sources: SourceRegistrationsSchema,
  profileApplications: Schema.optionalKey(Schema.Array(ProfileApplicationSchema)),
});

/**
 * Validates the runtime model. State-file documents use PersistableStateSchema in state-codec.ts,
 * which adds the cross-collection ownership checks to this schema.
 */
export const StateSchema = Schema.Struct({
  format: Schema.Literal(stateFormat),
  data: StateDataSchema,
}).check(
  Schema.makeFilter((state) => {
    const applications = state.data.profileApplications;
    return applications === undefined ||
      new Set(applications.map((entry) => choiceNamespaceIdentity(entry.namespace))).size ===
        applications.length
      ? []
      : ["Only one fixed application may own a context."];
  }),
);

/** State consumed by feature workflows and checkpoint callbacks. */
export type State = typeof StateSchema.Type;

/** One registered project as the runtime model holds it, with its intent and handoff roots. */
export type StateProject = State["data"]["projects"][number];

/** A state with every collection present and nothing recorded in it. */
export const emptyState = (): State => ({
  data: {
    enabledAdapters: [],
    sources: [],
    projects: [],
    userChoices: [],
    links: [],
  },
  format: stateFormat,
});
