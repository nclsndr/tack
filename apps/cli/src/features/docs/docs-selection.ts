import { Effect, FileSystem, Schema } from "effect";
import type {
  ReaderProjectInput,
  ReaderResource,
  ReaderResourceIssue,
} from "@tackup/reader/search-core";
import type { State } from "../../domain/state/state-schema.ts";
import type { StateOptions } from "../../services/state-store.ts";
import { readInvocationSnapshot } from "../snapshot/command-snapshot.ts";
import { docsSettingsFor } from "../../domain/state/state-intent.ts";
import {
  activeProjects,
  ProjectNotFoundError,
  resolveContainingRoot,
  TargetSelectionError,
} from "../projects/project.ts";
import type { Catalog } from "../../domain/sources/catalog-schema.ts";
import { shortestReference } from "../sources/resource-reference.ts";
import { DocsError, DocsResourceReferenceSchema } from "../../domain/docs/docs-schema.ts";
import { findDocsEntry } from "./docs-resource.ts";

export type DocsSelector = { readonly projectName?: string; readonly cwd?: string };

const projectNotFound = (selector: DocsSelector, canonicalCwd: string) =>
  selector.projectName === undefined
    ? new TargetSelectionError({
        code: "bare-target-requires-registered-root",
        message:
          "Choose an active registered project with --project, or run inside a registered project root.",
        path: canonicalCwd,
      })
    : new ProjectNotFoundError({ code: "project-not-found", projectName: selector.projectName });

/**
 * Names the project a docs mutation changes. An explicit project wins and must be an active
 * registered project. Otherwise the cwd selects the active project owning its deepest containing
 * root, as `docs` and `docs target` do. Mutations change only state, so no root is observed.
 */
export const selectDocsProjectName = Effect.fnUntraced(function* (
  state: State,
  selector: DocsSelector,
) {
  if (selector.projectName !== undefined) {
    const registered = activeProjects(state).some(
      (project) => project.name === selector.projectName,
    );
    if (registered === false)
      return yield* new ProjectNotFoundError({
        code: "project-not-found",
        projectName: selector.projectName,
      });
    return selector.projectName;
  }
  const { canonicalCwd, containing } = yield* resolveContainingRoot(
    state,
    selector.cwd ?? ".",
  ).pipe(
    Effect.mapError(
      (error) => new DocsError({ code: "docs-project-unavailable", message: error.message }),
    ),
  );
  if (containing === undefined) return yield* projectNotFound(selector, canonicalCwd);
  return containing.projectName;
});
/**
 * Resolves only an active registered project and one of its canonical roots. Without an explicit
 * project, the cwd selects the project owning its deepest containing root, as target selection
 * does. With an explicit project, the cwd only chooses which of that project's roots to use.
 */
export const selectDocsProject = Effect.fnUntraced(function* (
  state: State,
  selector: DocsSelector,
) {
  const fs = yield* FileSystem.FileSystem;
  const { canonicalCwd, containing } = yield* resolveContainingRoot(
    state,
    selector.cwd ?? ".",
    selector.projectName === undefined ? {} : { projectName: selector.projectName },
  ).pipe(
    Effect.mapError(
      (error) => new DocsError({ code: "docs-project-unavailable", message: error.message }),
    ),
  );
  const projectName = selector.projectName ?? containing?.projectName;
  const project = activeProjects(state).find((candidate) => candidate.name === projectName);
  if (project === undefined) return yield* projectNotFound(selector, canonicalCwd);
  const root = containing?.root ?? project.roots[0];
  if (root === undefined)
    return yield* new DocsError({
      code: "docs-project-unavailable",
      message: "The registered project has no active root.",
    });
  const actual = yield* fs
    .realPath(root)
    .pipe(
      Effect.mapError(
        (error) => new DocsError({ code: "docs-project-unavailable", message: error.message }),
      ),
    );
  if (actual !== root)
    return yield* new DocsError({
      code: "docs-project-unavailable",
      message: "The registered root has moved; refresh the project registration.",
    });
  return { project, root };
});

/** The registered project a reader input belongs to. */
export const ReaderProjectSchema = Schema.Struct({ name: Schema.String, root: Schema.String });

/** An attached resource, or one document inside it, that did not load; a document has a `path`. */
export const ReaderResourceIssueSchema = Schema.Struct({
  resource: DocsResourceReferenceSchema,
  sourcePath: Schema.String,
  code: Schema.String,
  message: Schema.String,
  path: Schema.optional(Schema.String),
});

/** An incomplete reader setup: the project has no attached docs, with a valid way to attach one. */
export const DocsSetupGapSchema = Schema.Struct({
  code: Schema.Literal("no-docs-attached"),
  message: Schema.String,
  next: Schema.String,
});

/** An incomplete reader setup: the project has no attached docs, with a valid way to attach one. */
export type DocsSetupGap = typeof DocsSetupGapSchema.Type;

/**
 * Reports an empty setup, which no search or serve can call complete. The next step names a
 * healthy catalog resource when one exists, so it is a command that attaches something real.
 */
const docsSetupGap = (
  input: ReaderProjectInput,
  catalog: Pick<Catalog, "entries">,
): DocsSetupGap | undefined => {
  if (input.resources.length + input.issues.length > 0) return undefined;
  const project = input.project.name;
  const candidate = catalog.entries.find((entry) => entry.address.kind === "docs");
  if (candidate === undefined)
    return {
      code: "no-docs-attached",
      message: `Project ${project} has no attached docs and no registered source declares a docs resource. Add a source that declares docs in its tack.yaml, then attach one.`,
      next: "tack source add <path-to-a-source-that-declares-docs>",
    };
  return {
    code: "no-docs-attached",
    message: `Project ${project} has no attached docs, so there is nothing to search or serve. Attach one of the declared docs resources.`,
    next: `tack docs attach ${shortestReference(catalog, candidate)} --project ${project}`,
  };
};

/** Resolves the project's attached resources and the catalog they were resolved against. */
export const resolveProjectDocsContextFromState = Effect.fnUntraced(function* (
  state: State,
  catalog: Catalog,
  selector: DocsSelector,
) {
  const { project, root } = yield* selectDocsProject(state, selector);
  const input = projectDocsInput(state, catalog, project.name, root);
  const setup = docsSetupGap(input, catalog);
  return { input, ...(setup === undefined ? {} : { setup }) };
});

/** Resolves the project's attached resources through the existing source catalog. */
const resolveProjectDocsFromState = Effect.fnUntraced(function* (
  state: State,
  catalog: Catalog,
  selector: DocsSelector,
) {
  return (yield* resolveProjectDocsContextFromState(state, catalog, selector)).input;
});

/** Splits one selected project's attachments into healthy reader resources and issues. */
export const projectDocsInput = (
  state: State,
  catalog: Catalog,
  projectName: string,
  root: string,
) => {
  const settings = docsSettingsFor(state, projectName);
  const resources: ReaderResource[] = [];
  const issues: ReaderResourceIssue[] = [];
  for (const resource of settings?.attachments ?? []) {
    const entry = findDocsEntry(catalog, resource);
    if (entry !== undefined) {
      resources.push({
        ...resource,
        sourcePath: entry.sourcePath,
        directoryPath: entry.directoryPath,
        readerConfig: entry.readerConfig,
      });
    } else {
      const source = state.data.sources.find(
        (candidate) => candidate.id === resource.sourceRegistrationId,
      );
      const quarantine = catalog.quarantined.find(
        (item) =>
          item.sourceRegistrationId === resource.sourceRegistrationId &&
          item.address?.kind === "docs" &&
          item.address.name === resource.name,
      );
      const unhealthy = catalog.unhealthySources.find(
        (item) => item.registration.id === resource.sourceRegistrationId,
      );
      issues.push({
        resource,
        sourcePath: source?.canonicalPath ?? "",
        code: quarantine?.code ?? "docs-resource-unavailable",
        message:
          quarantine?.message ??
          (unhealthy === undefined
            ? "The attached docs resource is no longer declared by its registered source."
            : "The registered source is unavailable."),
      });
    }
  }
  return {
    project: { name: projectName, root },
    resources,
    issues,
    ...(settings?.defaultWritingResource === undefined
      ? {}
      : { defaultWritingResource: settings.defaultWritingResource }),
  } satisfies ReaderProjectInput;
};

/** Resolves one registered reader input and its setup gap without changing state or links. */
export const resolveProjectDocsContext = Effect.fnUntraced(function* (
  options: StateOptions,
  selector: DocsSelector,
) {
  const snapshot = yield* readInvocationSnapshot(options);
  return yield* resolveProjectDocsContextFromState(
    snapshot.state,
    yield* snapshot.catalog,
    selector,
  );
});

/** Resolves one registered reader input without changing local state or links. */
export const resolveProjectDocs = Effect.fn("docs.resolveProjectDocs")(function* (
  options: StateOptions,
  selector: DocsSelector,
) {
  const snapshot = yield* readInvocationSnapshot(options);
  return yield* resolveProjectDocsFromState(snapshot.state, yield* snapshot.catalog, selector);
});
