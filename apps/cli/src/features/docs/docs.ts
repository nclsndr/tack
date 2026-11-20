import { requireDefaultSelection } from "../../domain/profiles/profile-application.ts";
import { Effect, Path, Schema } from "effect";
import { docsSettingsFor, withDocsSettings } from "../../domain/state/state-intent.ts";
import { mutateStateEffect, type StateOptions } from "../../services/state-store.ts";
import { type State } from "../../domain/state/state-schema.ts";
import { makeCommandSnapshot, readInvocationSnapshot } from "../snapshot/command-snapshot.ts";
import { observeDestination } from "../../services/destination.ts";
import {
  DocsError,
  DocsDestinationSchema,
  DocsProjectSchema,
  DocsResourceReferenceSchema,
  docsLink,
  docsResourceIdentity,
  managedDocsLinksOf,
  type DocsLinkAction,
  type DocsProject,
  type DocsResourceReference,
  type DocsResourceRequest,
} from "../../domain/docs/docs-schema.ts";
import {
  DocsSetupGapSchema,
  ReaderProjectSchema,
  ReaderResourceIssueSchema,
  projectDocsInput,
  resolveProjectDocsContextFromState,
  selectDocsProject,
  selectDocsProjectName,
  type DocsSelector,
} from "./docs-selection.ts";
import {
  docsDestinationPath,
  findDocsEntry,
  observeDocsSources,
  resolveDocsResource,
  type DocsSources,
} from "./docs-resource.ts";
import { planDocsLinks } from "./docs-links.ts";
import { checkDocsParents, classifyDestination } from "../links/link-delivery.ts";
import type { Catalog } from "../../domain/sources/catalog-schema.ts";
import { inspectCatalog, referenceFor } from "../sources/resource-reference.ts";
import { ReaderCorpus } from "../../services/reader-corpus.ts";
export { resolveProjectDocs } from "./docs-selection.ts";

const settingsFor = (state: State, projectName: string): DocsProject =>
  docsSettingsFor(state, projectName) ?? {
    projectName,
    attachments: [],
  };
const withSettings = withDocsSettings;
const decodeResource = (resource: DocsResourceReference) =>
  Schema.decodeUnknownEffect(DocsResourceReferenceSchema)(resource).pipe(
    Effect.mapError(
      (error) => new DocsError({ code: "docs-resource-invalid", message: error.message }),
    ),
  );
const decodeName = (name: string) =>
  Schema.decodeUnknownEffect(DocsResourceReferenceSchema.fields.name)(name).pipe(
    Effect.mapError(
      (error) => new DocsError({ code: "docs-resource-invalid", message: error.message }),
    ),
  );
/** Validates the requested name, then resolves the request to one source-qualified identity. */
const resolveRequest = Effect.fnUntraced(function* (
  sources: DocsSources,
  request: DocsResourceRequest,
  selector: DocsSelector,
) {
  yield* decodeName(request.reference.split(":").at(-1) ?? "");
  return yield* decodeResource(yield* resolveDocsResource(sources, request, selector.cwd ?? "."));
});
const isAttached = (settings: DocsProject, resource: DocsResourceReference) =>
  settings.attachments.some(
    (entry) => docsResourceIdentity(entry) === docsResourceIdentity(resource),
  );

/** The `docs attach`, `docs detach` and `docs configure` payload: the project's docs settings after the call. */
export const DocsSettingsPayloadSchema = Schema.Struct({
  kind: Schema.Literal("docs-settings"),
  ...DocsProjectSchema.fields,
});

/** Attaches one catalog resource as local intent; materialization requires reconcile --apply. */
export const attachDocs = Effect.fnUntraced(function* (
  options: StateOptions,
  selector: DocsSelector,
  request: DocsResourceRequest,
) {
  return yield* mutateStateEffect(options, (state) =>
    Effect.gen(function* () {
      const projectName = yield* selectDocsProjectName(state, selector);
      yield* requireDefaultSelection(state, { _tag: "project", projectName });
      const sources = yield* observeDocsSources(yield* makeCommandSnapshot(state));
      const resource = yield* resolveRequest(sources, request, selector);
      if (findDocsEntry(sources.catalog, resource) === undefined)
        return yield* new DocsError({
          code: "docs-resource-unavailable",
          message: `Choose a healthy declared docs resource from ${inspectCatalog.join(" ")}.`,
          details: { resource },
          next: [inspectCatalog],
        });
      const settings = settingsFor(state, projectName);
      const next =
        isAttached(settings, resource) === true
          ? settings
          : { ...settings, attachments: [...settings.attachments, resource] };
      return { state: withSettings(state, next), value: next };
    }),
  );
});

/** Removes attachment intent and its writing default while retaining link deletion authority. */
export const detachDocs = Effect.fnUntraced(function* (
  options: StateOptions,
  selector: DocsSelector,
  request: DocsResourceRequest,
) {
  return yield* mutateStateEffect(options, (state) =>
    Effect.gen(function* () {
      const projectName = yield* selectDocsProjectName(state, selector);
      yield* requireDefaultSelection(state, { _tag: "project", projectName });
      const decoded = yield* resolveRequest(
        yield* observeDocsSources(yield* makeCommandSnapshot(state)),
        request,
        selector,
      );
      const settings = settingsFor(state, projectName);
      const next = {
        ...settings,
        attachments: settings.attachments.filter(
          (entry) => docsResourceIdentity(entry) !== docsResourceIdentity(decoded),
        ),
      };
      if (
        next.defaultWritingResource !== undefined &&
        docsResourceIdentity(next.defaultWritingResource) === docsResourceIdentity(decoded)
      )
        delete next.defaultWritingResource;
      return { state: withSettings(state, next), value: next };
    }),
  );
});

/** Sets local destination or default-writing intent without writing project files. */
export const configureDocs = Effect.fnUntraced(function* (
  options: StateOptions,
  selector: DocsSelector,
  changes: {
    readonly destination?: string;
    readonly defaultWritingResource?: DocsResourceRequest;
    readonly clearDefault?: boolean;
  },
) {
  if (changes.destination !== undefined)
    yield* Schema.decodeUnknownEffect(DocsDestinationSchema)(changes.destination).pipe(
      Effect.mapError(
        (error) => new DocsError({ code: "docs-destination-invalid", message: error.message }),
      ),
    );
  return yield* mutateStateEffect(options, (state) =>
    Effect.gen(function* () {
      const projectName = yield* selectDocsProjectName(state, selector);
      yield* requireDefaultSelection(state, { _tag: "project", projectName });
      const settings = settingsFor(state, projectName);
      const next = {
        ...settings,
        ...(changes.destination === undefined ? {} : { destination: changes.destination }),
      };
      if (changes.clearDefault === true) delete next.defaultWritingResource;
      if (changes.defaultWritingResource !== undefined) {
        const resource = yield* resolveRequest(
          yield* observeDocsSources(yield* makeCommandSnapshot(state)),
          changes.defaultWritingResource,
          selector,
        );
        if (isAttached(settings, resource) === false)
          return yield* new DocsError({
            code: "docs-default-not-attached",
            message: "Attach the writing resource before selecting it as the default.",
            details: { resource },
          });
        next.defaultWritingResource = resource;
      }
      return { state: withSettings(state, next), value: next };
    }),
  );
});

/** How one attached resource is mounted in the project, as `docs` reports it. */
const DocsMountStateSchema = Schema.Literals(["mounted", "unmounted", "conflict", "stale"]);

const mountState = {
  conflict: "conflict",
  create: "unmounted",
  keep: "mounted",
  remove: "stale",
} as const satisfies Record<DocsLinkAction["action"], typeof DocsMountStateSchema.Type>;

/** An attached resource the reader can load, with its source checkout and reader config. */
const ReaderResourceSchema = Schema.Struct({
  ...DocsResourceReferenceSchema.fields,
  sourcePath: Schema.String,
  directoryPath: Schema.String,
  readerConfig: Schema.optional(
    Schema.Struct({ kind: Schema.Literals(["source", "file"]), path: Schema.String }),
  ),
});

/**
 * The `docs` payload: the project's attachments, the corpus search and serve would read, how each
 * attachment is mounted, its docs settings, and whether the coverage is complete.
 */
export const DocsListPayloadSchema = Schema.Struct({
  kind: Schema.Literal("docs-list"),
  project: ReaderProjectSchema,
  resources: Schema.Array(ReaderResourceSchema),
  issues: Schema.Array(ReaderResourceIssueSchema),
  documents: Schema.Number,
  mounts: Schema.Array(
    Schema.Struct({
      resource: DocsResourceReferenceSchema,
      destinationPath: Schema.String,
      state: DocsMountStateSchema,
      message: Schema.optionalKey(Schema.String),
    }),
  ),
  settings: Schema.Struct({
    destination: Schema.optionalKey(DocsDestinationSchema),
    defaultWritingResource: Schema.optionalKey(DocsResourceReferenceSchema),
  }),
  setup: Schema.optionalKey(DocsSetupGapSchema),
  complete: Schema.Boolean,
});

/** What inspecting one project's docs reports. */
export type DocsList = Omit<typeof DocsListPayloadSchema.Type, "kind">;

/**
 * Reports the whole docs picture of one project: its attachments, how each is mounted, and the
 * corpus search and serve would read. Coverage is complete only when every attached resource and
 * every selected document loads, so a bad document shows here with its path and cause while its
 * healthy siblings stay counted.
 */
export const inspectDocs = Effect.fnUntraced(function* (
  options: StateOptions,
  selector: DocsSelector,
) {
  const snapshot = yield* readInvocationSnapshot(options);
  const state = snapshot.state;
  const catalog = yield* snapshot.catalog;
  const { input, setup } = yield* resolveProjectDocsContextFromState(state, catalog, selector);
  const { destination, defaultWritingResource } = settingsFor(state, input.project.name);
  const corpus = yield* (yield* ReaderCorpus).loadProject(input);
  const plan = yield* planDocsLinks(state, catalog, { projectName: input.project.name });
  const docs: DocsList = {
    project: input.project,
    resources: input.resources,
    issues: corpus.issues,
    documents: corpus.documents.length,
    mounts: plan.actions.map((action) => ({
      resource: action.evidence.resource,
      destinationPath: action.evidence.destinationPath,
      state: mountState[action.action],
      ...(action.action === "conflict" ? { message: action.message } : {}),
    })),
    settings: {
      ...(destination === undefined ? {} : { destination }),
      ...(defaultWritingResource === undefined ? {} : { defaultWritingResource }),
    },
    ...(setup === undefined ? {} : { setup }),
    complete: corpus.complete && setup === undefined,
  };
  return docs;
});

/** The docs-only sync that mounts a project's attached docs, the fix for a missing mount. */
const mountDocs = (project: string) => [
  "tack",
  "sync",
  "--no-adapters",
  "--project",
  project,
  "--apply",
];

/** A message names one configure command per attached resource; Next offers the first few. */
const mostConfigureHints = 3;

/**
 * Explains an unresolved writing target with the exact command that fixes it: attaching a
 * resource, or choosing one of the attached resources as the default.
 */
const defaultUnset = (settings: DocsProject, catalog: Catalog) => {
  const project = settings.projectName;
  const configure = settings.attachments.map((resource) => [
    "tack",
    "docs",
    "configure",
    "--project",
    project,
    "--default",
    referenceFor(catalog, { kind: "docs", ...resource }),
  ]);
  return new DocsError({
    code: "docs-default-unset",
    message:
      configure.length === 0
        ? `Project ${project} has no attached docs resources. Attach one with tack docs attach <name> --project ${project}, then run ${mountDocs(project).join(" ")}.`
        : `Project ${project} has ${configure.length} attached docs resources and no default writing resource. Choose one with ${configure.map((command) => command.join(" ")).join(" or ")}, or pass --name to docs target.`,
    details: { projectName: project, candidates: settings.attachments },
    next: configure.length === 0 ? [mountDocs(project)] : configure.slice(0, mostConfigureHints),
  });
};

/** The `docs target` payload: a verified writing mount and the resource behind it. */
export const DocsTargetPayloadSchema = Schema.Struct({
  kind: Schema.Literal("docs-target"),
  projectName: Schema.String,
  root: Schema.String,
  resource: DocsResourceReferenceSchema,
  sourceDirectoryPath: Schema.String,
  destinationPath: Schema.String,
});

/** What resolving a writing target reports. */
type DocsTarget = Omit<typeof DocsTargetPayloadSchema.Type, "kind">;

/**
 * Returns a safe writing mount only after verifying persisted link ownership and its physical
 * target. Without an explicit resource, the default writing resource is used, or the only
 * attachment when no default is set.
 */
export const resolveDocsTarget = Effect.fnUntraced(function* (
  options: StateOptions,
  selector: DocsSelector & { readonly resource?: DocsResourceRequest },
) {
  const snapshot = yield* readInvocationSnapshot(options);
  const state = snapshot.state;
  const { project, root } = yield* selectDocsProject(state, selector);
  const settings = settingsFor(state, project.name);
  const sources = yield* observeDocsSources(snapshot);
  const [onlyAttachment, ...otherAttachments] = settings.attachments;
  const resource =
    selector.resource === undefined
      ? (settings.defaultWritingResource ??
        (otherAttachments.length === 0 ? onlyAttachment : undefined))
      : yield* resolveRequest(sources, selector.resource, selector);
  if (resource === undefined) return yield* defaultUnset(settings, sources.catalog);
  if (isAttached(settings, resource) === false)
    return yield* new DocsError({
      code: "docs-resource-not-attached",
      message: "The selected writing resource is not attached to this project.",
      details: { resource },
    });
  const destinationPath = docsDestinationPath(yield* Path.Path, root, settings, resource);
  const evidence = managedDocsLinksOf(state.data.links).find(
    (entry) =>
      entry.destinationPath === destinationPath &&
      docsResourceIdentity(entry.resource) === docsResourceIdentity(resource),
  );
  const input = projectDocsInput(state, sources.catalog, project.name, root);
  const current = input.resources.find(
    (entry) => docsResourceIdentity(entry) === docsResourceIdentity(resource),
  );
  if (evidence !== undefined)
    yield* checkDocsParents(docsLink(evidence), false).pipe(
      Effect.mapError(
        (error) => new DocsError({ code: "docs-mount-unavailable", message: error.message }),
      ),
    );
  const observation = yield* observeDestination(destinationPath);
  if (
    evidence === undefined ||
    current === undefined ||
    current.directoryPath !== evidence.sourceDirectoryPath ||
    (yield* classifyDestination(observation, docsLink(evidence))) !== "linked"
  )
    return yield* new DocsError({
      code: "docs-mount-unavailable",
      message: `The writing mount is absent, unhealthy, or not managed. Run ${mountDocs(project.name).join(" ")} and resolve conflicts first.`,
      next: [mountDocs(project.name)],
    });
  const target: DocsTarget = {
    projectName: project.name,
    root,
    resource,
    sourceDirectoryPath: evidence.sourceDirectoryPath,
    destinationPath,
  };
  return target;
});
