import { BundleError } from "../../domain/bundles/bundle-error.ts";
import type { FixedProfileError } from "../../domain/profiles/profile-application.ts";
import { Predicate, Schema, type PlatformError } from "effect";
import { posixPath } from "../../domain/identity/portable.ts";
import { stateFormat } from "../../domain/state/state-format.ts";
import type { InvocationError } from "../commands/index.ts";
import type {
  ChoiceProjectNotFoundError,
  ChoiceProjectRemovingError,
} from "../../features/choices/choice.ts";
import type { DocsError } from "../../domain/docs/docs-schema.ts";
import type { HistoryNotFoundError } from "../../features/execution/execution.ts";
import type { ResourceReferenceError } from "../../features/sources/resource-reference.ts";
import type { AdapterDisablementValidationError } from "../../features/maintenance/adapter-disablement.ts";
import type {
  ProjectNotFoundError,
  ProjectRegistrationConflictError,
  ProjectRootOwnershipError,
  TargetSelectionError,
} from "../../features/projects/project.ts";
import type {
  ProjectStorageError,
  ProjectValidationError,
} from "../../features/projects/project-observation.ts";
import type { ProjectRefreshEvidenceError } from "../../features/refresh/project-refresh.ts";
import type {
  AgentDisablementRequiredError,
  AgentSelectionValidationError,
} from "../../features/reconciliation/agent.ts";
import type {
  RemovalProjectNotFoundError,
  RemovalRootNotFoundError,
} from "../../domain/reconciliation/removal-schema.ts";
import type {
  SourcePathConflictError,
  SourceRegistrationNotFoundError,
  SourceStorageError,
  SourceValidationError,
} from "../../features/sources/source.ts";
import type { SourceRemovalError } from "../../features/maintenance/source-removal.ts";
import type { SourceAddRequestError } from "../../features/sources/source-scaffold.ts";
import type { ImportError } from "../../features/imports/import-error.ts";
import type { ExecutionError } from "../../services/execution-platform.ts";
import type { ImportFetchError } from "../../services/import-remote.ts";
import type { GitCommandError, GitOutputParseError } from "../../services/git.ts";
import type { ReaderStartupError } from "../../services/reader.ts";
import type { FigureCheckError, ReaderSearchError } from "../../services/reader-corpus.ts";
import type {
  StateBusyError,
  StateConfigurationError,
  StateCorruptError,
  StateFormatUnsupportedError,
  StateMutationError,
  StateNotInitializedError,
  StateStorageError,
} from "../../services/state-store.ts";
import type { NextCommands } from "../../domain/hints/next-commands.ts";
import { argvLine, invocation } from "./command-line.ts";
import { oneLine } from "./human/run-text.ts";
import type { PublicOutcome } from "./public-outcome.ts";
import type { ExplorerInterruptedError } from "./routes/explore.ts";

/** Reports host configuration that cannot be resolved before command dispatch. */
export class HostConfigurationError extends Schema.TaggedError<HostConfigurationError>()(
  "HostConfigurationError",
  {
    code: Schema.Literals(["home-directory-unavailable", "state-directory-environment-invalid"]),
    message: Schema.String,
  },
) {}

/** Every typed failure a command route can end with. */
export type HostFailure =
  | BundleError
  | FixedProfileError
  | AdapterDisablementValidationError
  | AgentDisablementRequiredError
  | AgentSelectionValidationError
  | ChoiceProjectNotFoundError
  | ChoiceProjectRemovingError
  | DocsError
  | ExecutionError
  | ExplorerInterruptedError
  | GitCommandError
  | GitOutputParseError
  | HistoryNotFoundError
  | HostConfigurationError
  | ImportError
  | ImportFetchError
  | InvocationError
  | PlatformError.PlatformError
  | ProjectNotFoundError
  | ProjectRefreshEvidenceError
  | ProjectRegistrationConflictError
  | ProjectRootOwnershipError
  | ProjectStorageError
  | ProjectValidationError
  | FigureCheckError
  | ReaderSearchError
  | ReaderStartupError
  | ResourceReferenceError
  | RemovalProjectNotFoundError
  | RemovalRootNotFoundError
  | SourceAddRequestError
  | SourcePathConflictError
  | SourceRegistrationNotFoundError
  | SourceRemovalError
  | SourceStorageError
  | SourceValidationError
  | StateBusyError
  | StateConfigurationError
  | StateCorruptError
  | StateFormatUnsupportedError
  | StateMutationError
  | StateNotInitializedError
  | StateStorageError
  | TargetSelectionError;

type Classification = PublicOutcome["classification"];
type Details = { readonly [key: string]: Schema.Json };

/**
 * How one error tag becomes a public diagnostic. `code` defaults to the error's own `code` field
 * and `message` to its own message. `details` defaults to the error's JSON-safe schema fields minus
 * `_tag` and `code`; `false` exposes none. `next` lists the commands the message names as the fix,
 * as data, so the envelope's `next` never reads them back out of the message.
 */
type ErrorRule<E> = {
  readonly classification: Classification | ((error: E) => Classification);
  readonly code?: string | ((error: E) => string);
  readonly message?: string | ((error: E) => string);
  readonly details?: false | ((error: E) => Details);
  readonly next?: (error: E) => NextCommands;
};

type ErrorRegistry = {
  readonly [K in HostFailure["_tag"]]: ErrorRule<Extract<HostFailure, { readonly _tag: K }>>;
};

const isJson = Schema.is(Schema.Json);

/** Copies the error's own schema fields that are JSON values, skipping identity and code. */
const safeFields = (error: object, omit: ReadonlyArray<string> = []): Details =>
  Object.fromEntries(
    Object.entries(error).filter(
      ([key, value]) =>
        key !== "_tag" &&
        key !== "code" &&
        !omit.includes(key) &&
        value !== undefined &&
        isJson(value),
    ),
  );

const listProjects = invocation("project-list");

/** The message for a project name that no registration has. */
export const notRegistered = (projectName: string) =>
  `Project "${projectName}" is not registered. Run \`${argvLine(listProjects)}\` to list registered projects and roots.`;

const storageFailureMessage = "Tack could not safely access persisted data.";

/**
 * A target that names no registered project, project root or containing root is a configuration
 * failure in every command, as script run resolution already reports it (`run_project_not_registered`,
 * `run_cwd_not_registered`): the operator must change the selector or the registration.
 */
const unresolvedTarget: Classification = "invalid-configuration";

/**
 * Docs failures by code: selection and settings problems are configuration; conditions observed in
 * the filesystem at run time are domain failures. Codes added later default to configuration.
 */
const docsClassifications: { readonly [code: string]: Classification } = {
  "docs-default-not-attached": "invalid-configuration",
  "docs-default-unset": "invalid-configuration",
  "docs-destination-escape": "invalid-configuration",
  "docs-destination-invalid": "invalid-configuration",
  "docs-resource-ambiguous": "invalid-configuration",
  "docs-resource-invalid": "invalid-configuration",
  "docs-resource-not-attached": "invalid-configuration",
  "docs-destination-changed": "domain",
  "docs-mount-unavailable": "domain",
  "docs-parent-not-directory": "domain",
  "docs-parent-redirected": "domain",
  "docs-project-unavailable": "domain",
  "docs-resource-unavailable": "domain",
  "docs-root-moved": "domain",
  "docs-source-not-registered": "invalid-configuration",
  "docs-source-changed": "domain",
  "docs-verification-failed": "domain",
};

const projectNotFound = {
  classification: unresolvedTarget,
  code: "project-not-found",
  message: (error: { readonly projectName: string }) => notRegistered(error.projectName),
  next: () => [listProjects],
} as const;

/** The fix a re-registration with other roots names: refresh the project in place. */
const refreshRegistration = (projectName: string) =>
  invocation("project-refresh", "--project", projectName, "--apply");

const listSources = invocation("source-list");
const previewSync = invocation("sync");
const update = invocation("upgrade");

/** The command that initializes the exact state directory a missing state file belongs to. */
const initializeState = (statePath: string) => [
  "tack",
  "--state-dir",
  posixPath.dirname(statePath),
  "state",
  "init",
];

/** The one mapping from a typed failure to its public code, classification, message and details. */
export const errorRegistry: ErrorRegistry = {
  // A plan Tack built and validates under the same lock failing validation is an internal fault.
  AdapterDisablementValidationError: {
    classification: "internal",
    code: "adapter-disablement-plan-invalid",
  },
  AgentDisablementRequiredError: { classification: "domain" },
  AgentSelectionValidationError: { classification: "invalid-invocation" },
  ChoiceProjectNotFoundError: projectNotFound,
  FixedProfileError: { classification: "domain" },
  BundleError: { classification: "domain" },
  ChoiceProjectRemovingError: {
    classification: "domain",
    message: (error) =>
      `Project "${error.projectName}" is being removed, so its choices cannot change.`,
  },
  DocsError: {
    classification: (error) => docsClassifications[error.code] ?? "invalid-configuration",
    // Repair facts, such as the candidates of an ambiguous name, are public at the top level.
    details: (error) => ({
      ...safeFields(error, ["details", "next"]),
      ...safeFields(error.details ?? {}),
    }),
    next: (error) => error.next ?? [],
  },
  ExecutionError: {
    classification: (error) => error.classification,
    details: (error) => ({
      stage: error.stage,
      ...(error.details === undefined ? {} : { outcome: error.details }),
    }),
  },
  ExplorerInterruptedError: { classification: "interruption" },
  GitCommandError: { classification: "domain" },
  GitOutputParseError: { classification: "domain", code: "git-output-invalid" },
  HistoryNotFoundError: {
    classification: "domain",
    code: "history-not-found",
    message: "No retained run has this identifier.",
  },
  HostConfigurationError: { classification: "invalid-configuration" },
  // A request the operator can repair is configuration; a write that failed or a refused
  // removal is a domain failure that changed nothing.
  ImportError: {
    // Repair facts, such as a corrected location, are public at the top level of the diagnostic.
    details: (error) => ({
      ...safeFields(error, ["details", "next"]),
      ...(Predicate.isObject(error.details) ? safeFields(error.details) : {}),
    }),
    next: (error) => error.next ?? [],
    classification: (error) =>
      error.code === "import-write-failed" ||
      error.code === "import-removal-blocked" ||
      error.code === "import-staging-conflict"
        ? "domain"
        : "invalid-configuration",
  },
  ImportFetchError: { classification: "domain" },
  InvocationError: {
    classification: "invalid-invocation",
    // The envelope already names the command.
    details: (error) => safeFields(error, ["command", "next"]),
    next: (error) => error.next ?? [],
  },
  PlatformError: {
    classification: "internal",
    code: "internal-error",
    message: "An unexpected internal error occurred.",
    details: false,
  },
  ProjectNotFoundError: projectNotFound,
  ProjectRefreshEvidenceError: {
    classification: "domain",
    message: (error) =>
      `Project "${error.projectName}" cannot be removed by refresh while managed links or cleanup obligations remain under roots refresh cannot account for: ${error.roots.join(", ")}.`,
  },
  ProjectRegistrationConflictError: {
    classification: "domain",
    message: (error) =>
      error.existingAnchor === error.observedAnchor
        ? `Project "${error.projectName}" is already registered for this repository with different roots or a pending removal. Run \`${argvLine(refreshRegistration(error.projectName))}\` to update its registration.`
        : `Project "${error.projectName}" is already registered for a different repository (${error.existingAnchor}). Choose another project name.`,
    next: (error) =>
      error.existingAnchor === error.observedAnchor ? [refreshRegistration(error.projectName)] : [],
  },
  ProjectRootOwnershipError: {
    classification: "domain",
    message: (error) =>
      `Root ${error.canonicalRoot} is already registered to project "${error.conflictingProjectName}".`,
  },
  ProjectStorageError: {
    classification: "persistence",
    message: storageFailureMessage,
  },
  ProjectValidationError: {
    classification: "invalid-configuration",
    details: (error) => safeFields(error, ["next"]),
    next: (error) => error.next ?? [],
  },
  FigureCheckError: {
    classification: (error) => (error.kind === "path" ? "invalid-invocation" : "internal"),
    code: (error) => (error.kind === "path" ? "figure-check-path" : "figure-check-read"),
    details: false,
  },
  ReaderSearchError: {
    classification: (error) =>
      error.kind === "configuration" ? "invalid-configuration" : "internal",
    code: (error) =>
      error.kind === "configuration" ? "reader-configuration" : "reader-search-read",
    details: false,
  },
  ReaderStartupError: {
    classification: (error) =>
      error.kind === "configuration" ? "invalid-configuration" : "domain",
    code: (error) =>
      error.kind === "configuration"
        ? "reader-configuration"
        : error.kind === "port-in-use"
          ? "reader-port-in-use"
          : "reader-startup",
    details: false,
  },
  ResourceReferenceError: {
    classification: "invalid-configuration",
    details: (error) => ({ candidates: error.candidates }),
    next: (error) => error.next ?? [],
  },
  RemovalProjectNotFoundError: projectNotFound,
  RemovalRootNotFoundError: {
    classification: unresolvedTarget,
    code: "project-root-not-found",
    message: (error) =>
      `Root ${error.canonicalRoot} is not registered to project "${error.projectName}".`,
  },
  SourceAddRequestError: {
    classification: "invalid-invocation",
    details: (error) => safeFields(error, ["next"]),
    next: (error) => error.next ?? [],
  },
  SourcePathConflictError: {
    classification: "domain",
    message: (error) =>
      `Source path ${error.sourcePath} is already registered as source ${error.conflictingRegistrationId}.`,
  },
  SourceRegistrationNotFoundError: {
    classification: "domain",
    message: (error) =>
      `No source registration has id ${error.registrationId}. Run \`${argvLine(listSources)}\` to list registered sources.`,
    next: () => [listSources],
  },
  SourceRemovalError: {
    classification: (error) => (error.code === "source-not-found" ? unresolvedTarget : "domain"),
    details: (error) => (error.candidates.length === 0 ? {} : { candidates: error.candidates }),
    next: (error) => (error.code === "source-not-found" ? [listSources] : []),
  },
  SourceStorageError: { classification: "persistence", message: storageFailureMessage },
  SourceValidationError: { classification: "invalid-configuration" },
  StateBusyError: {
    classification: "domain",
    code: "state-busy",
    message: (error) =>
      error.ownerPid === undefined
        ? `The state writer lock at ${error.lockPath} has no known owner. Remove it only after confirming no writer is running.`
        : `The state writer lock at ${error.lockPath} records process ${error.ownerPid} as its owner.`,
  },
  StateConfigurationError: {
    classification: "invalid-configuration",
    code: "state-configuration-invalid",
  },
  StateCorruptError: {
    classification: "persistence",
    code: "state-corrupt",
    message: (error) =>
      `The state file ${error.statePath} is corrupt: ${oneLine(error.message).replace(/\.$/, "")}. Tack changed nothing in it. Repair the file by hand, or move it aside and run \`${argvLine(initializeState(error.statePath))}\` to start empty: links it recorded stay on disk, and \`${argvLine(previewSync)}\` reports them as foreign-destination until you remove them.`,
  },
  StateFormatUnsupportedError: {
    classification: "persistence",
    code: "state-format-unsupported",
    message: (error) =>
      `State format ${error.foundFormat} at ${error.statePath} was written by a newer tack. This release reads format ${stateFormat}. Run \`${argvLine(update)}\`.`,
    next: () => [update],
  },
  StateMutationError: {
    classification: "persistence",
    code: "state-mutation-failed",
    message: storageFailureMessage,
  },
  StateNotInitializedError: {
    classification: "invalid-configuration",
    code: "state-not-initialized",
    message: (error) =>
      `Tack state is absent at ${error.statePath}. Run \`${argvLine(initializeState(error.statePath))}\` to initialize this exact directory.`,
    next: (error) => [initializeState(error.statePath)],
  },
  StateStorageError: {
    classification: "persistence",
    code: "state-storage-failed",
    message: storageFailureMessage,
  },
  TargetSelectionError: {
    classification: unresolvedTarget,
    details: (error) => safeFields(error, ["next"]),
    next: (error) => error.next ?? [],
  },
};

const internalOutcome: PublicOutcome = {
  classification: "internal",
  diagnostics: [
    {
      code: "internal-error",
      message: "An unexpected internal error occurred.",
      severity: "error",
    },
  ],
};

/** Reads the rule for one tag while keeping the rule's error type correlated with that tag. */
const ruleFor = <K extends HostFailure["_tag"]>(
  tag: K,
): ErrorRule<Extract<HostFailure, { readonly _tag: K }>> => errorRegistry[tag];

/** Maps one typed failure to its public outcome through {@link errorRegistry}. */
export const outcomeForError = (error: HostFailure): PublicOutcome => {
  const tag = error._tag;
  // Typed failures always carry a registered tag; anything else stays a redacted internal failure.
  if (!Object.hasOwn(errorRegistry, tag)) return internalOutcome;
  const rule: ErrorRule<HostFailure> = ruleFor(tag);
  const ownCode = "code" in error && Predicate.isString(error.code) ? error.code : undefined;
  const code = typeof rule.code === "function" ? rule.code(error) : (rule.code ?? ownCode);
  const message =
    typeof rule.message === "function" ? rule.message(error) : (rule.message ?? error.message);
  const next = rule.next?.(error) ?? [];
  const details =
    rule.details === false
      ? {}
      : rule.details === undefined
        ? safeFields(error)
        : rule.details(error);
  return {
    classification:
      typeof rule.classification === "function" ? rule.classification(error) : rule.classification,
    diagnostics: [
      {
        code: code ?? "internal-error",
        ...(Object.keys(details).length === 0 ? {} : { details }),
        message: message.length > 0 ? message : "The requested operation cannot be completed.",
        severity: "error",
      },
    ],
    ...(next.length === 0 ? {} : { next }),
  };
};
