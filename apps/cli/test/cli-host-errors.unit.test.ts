import { BundleError } from "../src/domain/bundles/bundle-error.ts";
import { FixedProfileError } from "../src/domain/profiles/profile-application.ts";
import { describe, expect, it } from "@effect/vitest";
import { InvocationError } from "../src/cli/commands/index.ts";
import {
  errorRegistry,
  HostConfigurationError,
  outcomeForError,
  type HostFailure,
} from "../src/cli/host/errors.ts";
import {
  ChoiceProjectNotFoundError,
  ChoiceProjectRemovingError,
  ChoiceUserLinkedError,
} from "../src/features/choices/choice.ts";
import { DocsError } from "../src/domain/docs/docs-schema.ts";
import { HistoryNotFoundError } from "../src/features/execution/execution.ts";
import { ImportError } from "../src/features/imports/import-error.ts";
import { ResourceReferenceError } from "../src/features/sources/resource-reference.ts";
import { AdapterDisablementValidationError } from "../src/features/maintenance/adapter-disablement.ts";
import {
  ProjectNotFoundError,
  ProjectRegistrationConflictError,
  ProjectRootOwnershipError,
  TargetSelectionError,
} from "../src/features/projects/project.ts";
import {
  ProjectStorageError,
  ProjectValidationError,
} from "../src/features/projects/project-observation.ts";
import { ProjectRefreshEvidenceError } from "../src/features/refresh/project-refresh.ts";
import {
  AdapterNotEnabledError,
  AgentDisablementRequiredError,
  AgentSelectionValidationError,
} from "../src/features/reconciliation/agent.ts";
import {
  RemovalProjectNotFoundError,
  RemovalRootNotFoundError,
} from "../src/domain/reconciliation/removal-schema.ts";
import {
  SourcePathConflictError,
  SourceRegistrationNotFoundError,
  SourceStorageError,
  SourceValidationError,
} from "../src/features/sources/source.ts";
import { SourceRemovalError } from "../src/features/maintenance/source-removal.ts";
import { SourceAddRequestError } from "../src/features/sources/source-scaffold.ts";
import { ExecutionError } from "../src/services/execution-platform.ts";
import { ExplorerInterruptedError } from "../src/cli/host/routes/explore.ts";
import { GitCommandError, GitOutputParseError } from "../src/services/git.ts";
import { ImportFetchError } from "../src/services/import-remote.ts";
import { ReaderStartupError } from "../src/services/reader.ts";
import { FigureCheckError, ReaderSearchError } from "../src/services/reader-corpus.ts";
import {
  StateBusyError,
  StateConfigurationError,
  StateCorruptError,
  StateFormatUnsupportedError,
  StateMutationError,
  StateNotInitializedError,
  StateStorageError,
} from "../src/services/state-store.ts";

type Case = {
  readonly error: HostFailure;
  readonly classification: string;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
  readonly next?: unknown;
};

const notRegistered = (projectName: string) =>
  `Project "${projectName}" is not registered. Run \`tack project\` to list registered projects and roots.`;
const storageFailure = "Tack could not safely access persisted data.";

/** One case per registered tag: the specific code, the feature's message and its safe fields. */
const cases: ReadonlyArray<Case> = [
  {
    error: new BundleError({ code: "profile-bundle-invalid", message: "Repair the artifact." }),
    classification: "domain",
    code: "profile-bundle-invalid",
    message: "Repair the artifact.",
  },
  {
    error: new BundleError({
      code: "profile-bundle-file-access-failed",
      message: "Bundle file /ci.tgz cannot be read: it does not exist.",
      path: "/ci.tgz",
      reason: "NotFound",
      operation: "stat",
      next: [["tack", "profile", "export", "--help"]],
    }),
    classification: "domain",
    code: "profile-bundle-file-access-failed",
    message: "Bundle file /ci.tgz cannot be read: it does not exist.",
    details: { path: "/ci.tgz", reason: "NotFound", operation: "stat" },
    next: [["tack", "profile", "export", "--help"]],
  },
  {
    error: new FixedProfileError({
      code: "profile-fixed-context",
      message: "Use a separate daily context.",
    }),
    classification: "domain",
    code: "profile-fixed-context",
    message: "Use a separate daily context.",
  },
  {
    error: new ResourceReferenceError({
      code: "resource-ambiguous",
      message: "Review matches two resources.",
      candidates: ["tack pick include team:review", "tack pick include me:review"],
    }),
    classification: "invalid-configuration",
    code: "resource-ambiguous",
    message: "Review matches two resources.",
    details: { candidates: ["tack pick include team:review", "tack pick include me:review"] },
  },
  {
    error: new ResourceReferenceError({
      code: "resource-not-found",
      message: "No healthy resource matches review.",
      candidates: [],
      next: [["tack", "catalog"]],
    }),
    classification: "invalid-configuration",
    code: "resource-not-found",
    message: "No healthy resource matches review.",
    details: { candidates: [] },
    next: [["tack", "catalog"]],
  },
  {
    error: new ExplorerInterruptedError({
      code: "interrupted",
      message: "The command was interrupted.",
    }),
    classification: "interruption",
    code: "interrupted",
    message: "The command was interrupted.",
  },
  {
    error: new AdapterDisablementValidationError({ message: "Plan shape is invalid." }),
    classification: "internal",
    code: "adapter-disablement-plan-invalid",
    message: "Plan shape is invalid.",
  },
  {
    error: new AdapterNotEnabledError({
      adapters: ["codex"],
      code: "adapter-not-enabled",
      enabledAdapters: ["cursor"],
      message: "Adapters codex are not enabled.",
    }),
    classification: "invalid-configuration",
    code: "adapter-not-enabled",
    message:
      "Adapter codex is not enabled, so sync does not link for it. Run `tack adapter enable codex`, then sync again.",
    details: { adapters: ["codex"], enabledAdapters: ["cursor"] },
    next: [["tack", "adapter", "enable", "codex"]],
  },
  {
    error: new AgentDisablementRequiredError({
      adapters: ["claude", "cursor"],
      code: "adapter-reenablement-blocked",
      message: "Adapters cannot be enabled until their pending disablement cleanup settles.",
    }),
    classification: "domain",
    code: "adapter-reenablement-blocked",
    message: "Adapters cannot be enabled until their pending disablement cleanup settles.",
    details: { adapters: ["claude", "cursor"] },
  },
  {
    error: new AgentSelectionValidationError({
      code: "enabled-adapters-invalid",
      message: "Adapters must be unique.",
    }),
    classification: "invalid-invocation",
    code: "enabled-adapters-invalid",
    message: "Adapters must be unique.",
  },
  {
    error: new ChoiceProjectNotFoundError({
      code: "choice-project-not-found",
      projectName: "nope",
    }),
    classification: "invalid-configuration",
    code: "project-not-found",
    message: notRegistered("nope"),
    details: { projectName: "nope" },
    next: [["tack", "project"]],
  },
  {
    error: new ChoiceProjectRemovingError({ code: "choice-project-removing", projectName: "old" }),
    classification: "domain",
    code: "choice-project-removing",
    message: 'Project "old" is being removed, so its choices cannot change.',
    details: { projectName: "old" },
  },
  {
    error: new ChoiceUserLinkedError({
      code: "project-exclude-refused",
      address: {
        kind: "skill",
        name: "review",
        sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
      },
      projectName: "app",
      message: "Project app cannot hide skill review.",
      next: [["tack", "pick", "exclude", "tools:review", "--kind", "skill", "--user"]],
    }),
    classification: "invalid-invocation",
    code: "project-exclude-refused",
    message: "Project app cannot hide skill review.",
    details: {
      subject: {
        address: {
          kind: "skill",
          name: "review",
          sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
        },
        projectName: "app",
      },
    },
    next: [["tack", "pick", "exclude", "tools:review", "--kind", "skill", "--user"]],
  },
  {
    error: new DocsError({ code: "docs-default-unset", message: "Configure a default." }),
    classification: "invalid-configuration",
    code: "docs-default-unset",
    message: "Configure a default.",
  },
  {
    error: new DocsError({
      code: "docs-mount-unavailable",
      message: "The mount is absent.",
      next: [["tack", "sync", "--no-adapters", "--project", "demo", "--apply"]],
    }),
    classification: "domain",
    code: "docs-mount-unavailable",
    message: "The mount is absent.",
    next: [["tack", "sync", "--no-adapters", "--project", "demo", "--apply"]],
  },
  {
    error: new DocsError({ code: "docs-destination-changed", message: "The destination changed." }),
    classification: "domain",
    code: "docs-destination-changed",
    message: "The destination changed.",
  },
  {
    error: new DocsError({ code: "docs-future-code", message: "Not yet registered." }),
    classification: "invalid-configuration",
    code: "docs-future-code",
    message: "Not yet registered.",
  },
  {
    error: new ExecutionError({
      classification: "invalid-configuration",
      code: "run_project_not_registered",
      details: { projectName: "nope" },
      message: "Project is not registered.",
      stage: "resolution",
    }),
    classification: "invalid-configuration",
    code: "run_project_not_registered",
    message: "Project is not registered.",
    details: { outcome: { projectName: "nope" }, stage: "resolution" },
  },
  {
    error: new GitCommandError({
      args: ["rev-parse", "--git-common-dir"],
      code: "git-process-failed",
      command: "git",
      cwd: "/outside",
      exitCode: 128,
      message: "Git exited with code 128.",
      phase: "exit",
      stderr: "fatal: not a git repository\n",
    }),
    classification: "domain",
    code: "git-process-failed",
    message: "Git exited with code 128.",
    details: {
      args: ["rev-parse", "--git-common-dir"],
      command: "git",
      cwd: "/outside",
      exitCode: 128,
      phase: "exit",
      stderr: "fatal: not a git repository\n",
    },
  },
  {
    error: new GitOutputParseError({ command: "git worktree list", message: "Malformed." }),
    classification: "domain",
    code: "git-output-invalid",
    message: "Malformed.",
    details: { command: "git worktree list" },
  },
  {
    error: new HistoryNotFoundError({ runId: "00000000-0000-4000-8000-000000000000" }),
    classification: "domain",
    code: "history-not-found",
    message: "No retained run has this identifier.",
    details: { runId: "00000000-0000-4000-8000-000000000000" },
  },
  {
    error: new HostConfigurationError({
      code: "home-directory-unavailable",
      message: "The operator home directory is unavailable.",
    }),
    classification: "invalid-configuration",
    code: "home-directory-unavailable",
    message: "The operator home directory is unavailable.",
  },
  {
    error: new ImportError({
      code: "import-selection-unknown",
      message: "The location has no skill named x.",
      details: { available: ["pdf"] },
    }),
    classification: "invalid-configuration",
    code: "import-selection-unknown",
    message: "The location has no skill named x.",
    details: { available: ["pdf"] },
  },
  {
    error: new ImportError({ code: "import-write-failed", message: "Nothing was changed." }),
    classification: "domain",
    code: "import-write-failed",
    message: "Nothing was changed.",
  },
  {
    error: new ImportError({
      code: "import-not-found",
      message: "Nothing has been imported.",
      details: { imported: [] },
      next: [["tack", "import"]],
    }),
    classification: "invalid-configuration",
    code: "import-not-found",
    message: "Nothing has been imported.",
    details: { imported: [] },
    next: [["tack", "import"]],
  },
  {
    error: new ImportFetchError({
      code: "import-network-failed",
      message: "Git could not reach the remote.",
    }),
    classification: "domain",
    code: "import-network-failed",
    message: "Git could not reach the remote.",
  },
  {
    error: new InvocationError({ code: "invalid-flag", command: "sync", message: "No --apply." }),
    classification: "invalid-invocation",
    code: "invalid-flag",
    message: "No --apply.",
  },
  {
    error: new InvocationError({
      code: "invalid-selector",
      command: "sync",
      message: "--project takes a project name.",
      next: [["tack", "project"]],
    }),
    classification: "invalid-invocation",
    code: "invalid-selector",
    message: "--project takes a project name.",
    next: [["tack", "project"]],
  },
  {
    error: new ProjectNotFoundError({ code: "project-not-found", projectName: "nope" }),
    classification: "invalid-configuration",
    code: "project-not-found",
    message: notRegistered("nope"),
    details: { projectName: "nope" },
    next: [["tack", "project"]],
  },
  {
    error: new ProjectRefreshEvidenceError({
      code: "project-refresh-evidence-unaccounted",
      projectName: "demo",
      roots: ["/gone/a", "/gone/b"],
    }),
    classification: "domain",
    code: "project-refresh-evidence-unaccounted",
    message:
      'Project "demo" cannot be removed by refresh while managed links or cleanup obligations remain under roots refresh cannot account for: /gone/a, /gone/b.',
    details: { projectName: "demo", roots: ["/gone/a", "/gone/b"] },
  },
  {
    error: new ProjectRegistrationConflictError({
      code: "project-registration-conflict",
      existingAnchor: "/repo/.git",
      existingRoots: ["/repo"],
      observedAnchor: "/repo/.git",
      observedRoots: ["/repo", "/repo-feature"],
      projectName: "demo",
    }),
    classification: "domain",
    code: "project-registration-conflict",
    message:
      'Project "demo" is already registered for this repository with different roots or a pending removal. Run `tack project refresh --project demo --apply` to update its registration.',
    details: {
      existingAnchor: "/repo/.git",
      existingRoots: ["/repo"],
      observedAnchor: "/repo/.git",
      observedRoots: ["/repo", "/repo-feature"],
      projectName: "demo",
    },
    next: [["tack", "project", "refresh", "--project", "demo", "--apply"]],
  },
  {
    error: new ProjectRegistrationConflictError({
      code: "project-registration-conflict",
      existingAnchor: "/other/.git",
      existingRoots: ["/other"],
      observedAnchor: "/repo/.git",
      observedRoots: ["/repo"],
      projectName: "demo",
    }),
    classification: "domain",
    code: "project-registration-conflict",
    message:
      'Project "demo" is already registered for a different repository (/other/.git). Choose another project name.',
    details: {
      existingAnchor: "/other/.git",
      existingRoots: ["/other"],
      observedAnchor: "/repo/.git",
      observedRoots: ["/repo"],
      projectName: "demo",
    },
  },
  {
    error: new ProjectRootOwnershipError({
      canonicalRoot: "/repo",
      code: "root-already-registered",
      conflictingProjectName: "first",
      projectName: "second",
    }),
    classification: "domain",
    code: "root-already-registered",
    message: 'Root /repo is already registered to project "first".',
    details: { canonicalRoot: "/repo", conflictingProjectName: "first", projectName: "second" },
  },
  {
    error: new ProjectStorageError({
      code: "project-access-failed",
      message: "EACCES: raw platform text",
      operation: "realPath",
      path: "/repo",
    }),
    classification: "persistence",
    code: "project-access-failed",
    message: storageFailure,
    details: { operation: "realPath", path: "/repo" },
  },
  {
    error: new ProjectValidationError({
      code: "repository-cwd-missing",
      message: "The repository directory does not exist.",
      path: "/missing",
    }),
    classification: "invalid-configuration",
    code: "repository-cwd-missing",
    message: "The repository directory does not exist.",
    details: { path: "/missing" },
  },
  {
    error: new FigureCheckError({
      kind: "path",
      message: "nope.mdx: no document or folder at this path",
    }),
    classification: "invalid-invocation",
    code: "figure-check-path",
    message: "nope.mdx: no document or folder at this path",
  },
  {
    error: new FigureCheckError({ kind: "read", message: "Unreadable." }),
    classification: "internal",
    code: "figure-check-read",
    message: "Unreadable.",
  },
  {
    error: new ReaderSearchError({ kind: "read", message: "Corpus unreadable." }),
    classification: "internal",
    code: "reader-search-read",
    message: "Corpus unreadable.",
  },
  {
    error: new ReaderStartupError({ kind: "port-in-use", message: "Port 4321 is in use." }),
    classification: "domain",
    code: "reader-port-in-use",
    message: "Port 4321 is in use.",
  },
  {
    error: new RemovalProjectNotFoundError({ projectName: "nope" }),
    classification: "invalid-configuration",
    code: "project-not-found",
    message: notRegistered("nope"),
    details: { projectName: "nope" },
    next: [["tack", "project"]],
  },
  {
    error: new RemovalRootNotFoundError({ canonicalRoot: "/repo", projectName: "demo" }),
    classification: "invalid-configuration",
    code: "project-root-not-found",
    message: 'Root /repo is not registered to project "demo".',
    details: { canonicalRoot: "/repo", projectName: "demo" },
  },
  {
    error: new SourceAddRequestError({
      code: "declaration-config-required",
      message: "/brain has no tack.yaml. Write its tack.yaml as JSON.",
      next: [["tack", "guide", "tack-yaml"]],
    }),
    classification: "invalid-invocation",
    code: "declaration-config-required",
    message: "/brain has no tack.yaml. Write its tack.yaml as JSON.",
    next: [["tack", "guide", "tack-yaml"]],
  },
  {
    error: new SourcePathConflictError({
      code: "source-path-already-registered",
      conflictingRegistrationId: "id-1",
      registrationId: "id-2",
      sourcePath: "/source",
    }),
    classification: "domain",
    code: "source-path-already-registered",
    message: "Source path /source is already registered as source id-1.",
    details: { conflictingRegistrationId: "id-1", registrationId: "id-2", sourcePath: "/source" },
  },
  {
    error: new SourceRemovalError({
      code: "source-not-found",
      message: "No registered source has the label or registration ID gone.",
      candidates: [],
    }),
    classification: "invalid-configuration",
    code: "source-not-found",
    message: "No registered source has the label or registration ID gone.",
    next: [["tack", "source"]],
  },
  {
    error: new SourceRemovalError({
      code: "source-label-ambiguous",
      message: "Source label twin belongs to several registrations. Use one registration ID.",
      candidates: ["id-1", "id-2"],
    }),
    classification: "domain",
    code: "source-label-ambiguous",
    message: "Source label twin belongs to several registrations. Use one registration ID.",
    details: { candidates: ["id-1", "id-2"] },
  },
  {
    error: new SourceRegistrationNotFoundError({
      code: "registration-not-found",
      registrationId: "id-9",
    }),
    classification: "domain",
    code: "registration-not-found",
    message: "No source registration has id id-9. Run `tack source` to list registered sources.",
    details: { registrationId: "id-9" },
    next: [["tack", "source"]],
  },
  {
    error: new SourceStorageError({
      code: "source-access-failed",
      message: "EACCES: raw platform text",
      operation: "readFile",
      path: "/source/tack.yaml",
    }),
    classification: "persistence",
    code: "source-access-failed",
    message: storageFailure,
    details: { operation: "readFile", path: "/source/tack.yaml" },
  },
  {
    error: new SourceValidationError({
      code: "source-missing",
      message: "The source path does not exist.",
      sourcePath: "/missing",
    }),
    classification: "invalid-configuration",
    code: "source-missing",
    message: "The source path does not exist.",
    details: { sourcePath: "/missing" },
  },
  {
    error: new StateBusyError({ lockPath: "/state/lock" }),
    classification: "domain",
    code: "state-busy",
    message:
      "The state writer lock at /state/lock has no known owner. Remove it only after confirming no writer is running.",
    details: { lockPath: "/state/lock" },
  },
  {
    error: new StateBusyError({ lockPath: "/state/lock", ownerPid: 123 }),
    classification: "domain",
    code: "state-busy",
    message: "The state writer lock at /state/lock records process 123 as its owner.",
    details: { lockPath: "/state/lock", ownerPid: 123 },
  },
  {
    error: new StateConfigurationError({ message: "TACK_STATE_DIR must not be empty." }),
    classification: "invalid-configuration",
    code: "state-configuration-invalid",
    message: "TACK_STATE_DIR must not be empty.",
  },
  {
    error: new StateCorruptError({
      message: 'Expected no excess property\n  at ["data"]["x"]',
      statePath: "/state/s.json",
    }),
    classification: "persistence",
    code: "state-corrupt",
    message:
      'The state file /state/s.json is corrupt: Expected no excess property at ["data"]["x"]. Tack changed nothing in it. Repair the file by hand, or move it aside and run `tack --state-dir /state state init` to start empty: links it recorded stay on disk, and `tack sync` reports them as foreign-destination until you remove them.',
    details: { statePath: "/state/s.json" },
  },
  {
    error: new StateFormatUnsupportedError({ foundFormat: 5, statePath: "/state/s.json" }),
    classification: "persistence",
    code: "state-format-unsupported",
    message:
      "State format 5 at /state/s.json was written by a newer tack. This release reads format 1. Run `tack upgrade`.",
    details: { foundFormat: 5, statePath: "/state/s.json" },
    next: [["tack", "upgrade"]],
  },
  {
    error: new StateMutationError({ message: "raw", statePath: "/state/s.json" }),
    classification: "persistence",
    code: "state-mutation-failed",
    message: storageFailure,
    details: { statePath: "/state/s.json" },
  },
  {
    error: new StateNotInitializedError({ statePath: "/state/s.json", explicitDirectory: true }),
    classification: "invalid-configuration",
    code: "state-not-initialized",
    message:
      "Tack state is absent at /state/s.json. Run `tack --state-dir /state state init` to initialize this exact directory.",
    details: { statePath: "/state/s.json" },
    next: [["tack", "--state-dir", "/state", "state", "init"]],
  },
  {
    error: new StateNotInitializedError({
      statePath: "/home/.tack/state.json",
      explicitDirectory: false,
    }),
    classification: "invalid-configuration",
    code: "state-not-initialized",
    message:
      "Tack is not set up on this machine: there is no state at /home/.tack/state.json. Run `tack init` to set it up.",
    details: { statePath: "/home/.tack/state.json" },
    next: [["tack", "init"]],
  },
  {
    error: new StateStorageError({ message: "raw", operation: "rename", path: "/state/s.json" }),
    classification: "persistence",
    code: "state-storage-failed",
    message: storageFailure,
    details: { operation: "rename", path: "/state/s.json" },
  },
  {
    error: new TargetSelectionError({
      code: "bare-target-requires-registered-root",
      message: "Bare target selection requires a cwd inside a registered active root.",
      path: "/outside",
    }),
    classification: "invalid-configuration",
    code: "bare-target-requires-registered-root",
    message: "Bare target selection requires a cwd inside a registered active root.",
    details: { path: "/outside" },
  },
];

describe("CLI error registry", () => {
  it("covers every registered failure tag with a pinned case", () => {
    expect(new Set(cases.map((entry) => entry.error._tag))).toEqual(
      new Set(Object.keys(errorRegistry)),
    );
  });

  it.each(cases)("maps $error._tag to $code", (entry) => {
    expect(outcomeForError(entry.error)).toEqual({
      classification: entry.classification,
      diagnostics: [
        {
          code: entry.code,
          ...(entry.details === undefined ? {} : { details: entry.details }),
          message: entry.message,
          severity: "error",
        },
      ],
      ...(entry.next === undefined ? {} : { next: entry.next }),
    });
  });
});
