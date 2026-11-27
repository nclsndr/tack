import { Schema } from "effect";
import { NextCommandsSchema } from "../../domain/hints/next-commands.ts";
import { commandDeclarations } from "./declarations.ts";
import type { DocsResourceRequest } from "../../domain/docs/docs-schema.ts";
import type { ChoiceNamespace } from "../../domain/choices/choice-schema.ts";
import type { TargetSelector } from "../../domain/projects/project-schema.ts";
import type { AgentAdapterId, AgentCapability } from "../../domain/agents/agent-adapter-schema.ts";
import type { ResourceKind, SelectableKind } from "../../domain/resources/kinds.ts";
import type { OperatorRunRequest } from "../../domain/execution/execution-schema.ts";

export const invocationErrorCodes = [
  "invalid-command",
  "invalid-flag",
  "invalid-selector",
  "missing-argument",
  "terminal-required",
] as const;

/** Reports a transport rule broken while a recognized command builds its invocation. */
export class InvocationIssue extends Schema.TaggedError<InvocationIssue>()("InvocationIssue", {
  code: Schema.Literals(invocationErrorCodes),
  message: Schema.String,
}) {}

/** Reports transport that cannot name one valid Tack command invocation. */
export class InvocationError extends Schema.TaggedError<InvocationError>()("InvocationError", {
  code: Schema.Literals(invocationErrorCodes),
  /** The public name of the recognized executable operation, or {@link unknownCommandName}. */
  command: Schema.String.check(Schema.isMinLength(1)),
  message: Schema.String,
  /** The commands the message names as the fix, as data the envelope's `next` is filled from. */
  next: Schema.optionalKey(NextCommandsSchema),
}) {}

/** An explicit `--project` wins; otherwise the cwd selects its containing registered project. */
type DocsSelection = {
  readonly projectName?: string;
  readonly cwd?: string;
};

type DocsResourceChange = DocsSelection & {
  readonly resource: DocsResourceRequest;
};

type SelectedRemoval = {
  readonly apply: boolean;
  /** Lists every cleanup action in the text view. */
  readonly details: boolean;
  readonly cwd?: string;
  readonly selector: TargetSelector;
};

/** Planning inputs for selected links and attached project docs mounts. */
export type ReconcilePlanningRequest = {
  readonly adapterOverride?: ReadonlyArray<AgentAdapterId>;
  readonly cwd?: string;
  readonly includeOptional: boolean;
  readonly noDocs: boolean;
  readonly requiredCapability?: AgentCapability;
  readonly selector: TargetSelector;
};

/** The parsed, transport-free request handled by the CLI application boundary. */
export type Invocation =
  | { readonly _tag: "help"; readonly commandPath: ReadonlyArray<string> }
  | { readonly _tag: "version" }
  | { readonly _tag: "doctor" }
  | {
      readonly _tag: "script-run";
      readonly reference: string;
      readonly request: Omit<OperatorRunRequest, "address">;
    }
  | { readonly _tag: "script-show"; readonly reference: string }
  | { readonly _tag: "types"; readonly path?: string; readonly apply: boolean }
  | { readonly _tag: "history-list"; readonly limit: number; readonly offset: number }
  | { readonly _tag: "history-show"; readonly runId: string }
  | { readonly _tag: "history-clear"; readonly apply: boolean }
  | ({ readonly _tag: "docs-attach" } & DocsResourceChange)
  | ({ readonly _tag: "docs-detach" } & DocsResourceChange)
  | ({ readonly _tag: "docs-list" } & DocsSelection)
  | ({
      readonly _tag: "docs-configure";
      readonly destination?: string;
      readonly defaultWritingResource?: DocsResourceRequest;
      readonly clearDefault: boolean;
    } & DocsSelection)
  | ({ readonly _tag: "docs-target"; readonly resource?: DocsResourceRequest } & DocsSelection)
  | {
      readonly _tag: "docs-search";
      readonly query: string;
      readonly limit: number;
      readonly type?: string;
      readonly status?: string;
      readonly tag?: string;
      readonly projectName?: string;
      readonly cwd?: string;
    }
  | {
      readonly _tag: "check";
      readonly paths: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "guide";
      /** The guide to print, as typed; absent, the guides are listed. */
      readonly topic?: string;
    }
  | {
      readonly _tag: "docs-icons";
      readonly word?: string;
    }
  | {
      readonly _tag: "docs-serve";
      readonly projectName?: string;
      readonly cwd?: string;
      /** An explicit browser choice; absent, the host opens one only at an interactive terminal. */
      readonly open?: boolean;
      readonly port?: number;
    }
  | { readonly _tag: "init" }
  | {
      readonly _tag: "machine-init";
      /** The adapters `--adapter` named, replacing detection; absent when none was given. */
      readonly adapters?: ReadonlyArray<AgentAdapterId>;
    }
  | {
      readonly _tag: "import-add";
      readonly location: string;
      readonly into?: string;
      readonly skills: ReadonlyArray<string>;
      readonly all: boolean;
      readonly fullDepth: boolean;
      readonly apply: boolean;
    }
  | { readonly _tag: "import-list" }
  | {
      readonly _tag: "import-remove";
      readonly reference: string;
      readonly force: boolean;
      readonly apply: boolean;
    }
  | {
      readonly _tag: "source-add";
      readonly sourcePath: string;
      readonly apply?: boolean;
      /** The JSON declaration's file, or `-` for standard input, which a new tack.yaml takes. */
      readonly config?: string;
    }
  | {
      readonly _tag: "profile-apply";
      readonly reference: string;
      readonly namespace: ChoiceNamespace;
      readonly targetRoots: ReadonlyArray<string>;
      readonly targetHome?: string | undefined;
      readonly force: boolean;
      readonly apply: boolean;
    }
  | {
      readonly _tag: "profile-save";
      readonly sourcePath: string;
      readonly name: string;
      readonly input: "user+project" | "user" | "project";
      readonly projectName?: string;
      readonly edit: boolean;
      readonly apply: boolean;
    }
  | {
      readonly _tag: "profile-adopt";
      readonly reference: string;
      readonly namespace: ChoiceNamespace;
      readonly apply: boolean;
    }
  | {
      readonly _tag: "profile-export";
      readonly reference: string;
      readonly output: string;
      readonly apply: boolean;
    }
  | { readonly _tag: "profile-inspect-bundle"; readonly file: string }
  | {
      readonly _tag: "profile-apply-bundle";
      readonly file: string;
      readonly namespace: ChoiceNamespace;
      readonly targetRoots: ReadonlyArray<string>;
      readonly targetHome?: string;
      readonly force: boolean;
      readonly apply: boolean;
    }
  | {
      readonly _tag: "source-relocate";
      readonly registrationId: string;
      readonly sourcePath: string;
    }
  | { readonly _tag: "source-list" }
  | {
      readonly _tag: "source-remove";
      readonly source: string;
      readonly apply: boolean;
      readonly details: boolean;
    }
  | { readonly _tag: "project-add"; readonly name: string; readonly repositoryCwd?: string }
  | { readonly _tag: "project-list" }
  | {
      readonly _tag: "project-remove";
      readonly name: string;
      readonly apply: boolean;
      readonly details: boolean;
    }
  | {
      readonly _tag: "project-refresh";
      readonly apply: boolean;
      readonly details: boolean;
      readonly cwd?: string;
      readonly selector: Extract<TargetSelector, { readonly _tag: "bare" | "project" | "all" }>;
    }
  | {
      readonly _tag: "catalog";
      readonly details: boolean;
      /** Restricts the report to one resource kind. */
      readonly kind?: ResourceKind;
    }
  | {
      readonly _tag: "explore";
      /**
       * The selection the explorer opens on. Absent, it opens the project that contains the
       * working directory, or else the destination chooser.
       */
      readonly destination?: ChoiceNamespace;
    }
  | {
      readonly _tag: "choice-set";
      readonly reference: string;
      readonly kind?: SelectableKind;
      readonly namespace: ChoiceNamespace;
    }
  | {
      readonly _tag: "choice-exclude";
      readonly reference: string;
      readonly kind?: SelectableKind;
      readonly namespace: ChoiceNamespace;
    }
  | {
      readonly _tag: "choice-remove";
      readonly reference: string;
      readonly kind?: SelectableKind;
      readonly namespace: ChoiceNamespace;
    }
  | { readonly _tag: "pick-list"; readonly namespace?: ChoiceNamespace }
  | { readonly _tag: "adapter-set"; readonly adapters: ReadonlyArray<AgentAdapterId> }
  | {
      readonly _tag: "adapter-disable";
      readonly adapter: AgentAdapterId;
      readonly apply: boolean;
      readonly details: boolean;
    }
  | { readonly _tag: "adapter-list" }
  | {
      readonly _tag: "status";
      readonly cwd?: string;
      readonly includeOptional: boolean;
      readonly details: boolean;
      readonly selector: TargetSelector;
    }
  | ({ readonly _tag: "clean" } & SelectedRemoval)
  | ({ readonly _tag: "retry" } & SelectedRemoval)
  | { readonly _tag: "reset"; readonly apply: boolean; readonly details: boolean }
  | { readonly _tag: "upgrade-status" }
  | { readonly _tag: "upgrade" }
  | ({ readonly _tag: "sync"; readonly apply: boolean } & ReconcilePlanningRequest);

/** Format requests accepted by the shared root flag. */

/** One parsed command invocation beside the root transport settings shared by every command. */
export type ParsedInvocation = {
  readonly invocation: Invocation;
  readonly stateDirectory?: string;
};

/**
 * The invocation kinds that `--help` and `--version` select. They have no command word, so the
 * command tree does not declare them and `schema` publishes no contract for them.
 */
export type FlagRequestTag = "help" | "version";

/** The envelope command names of {@link FlagRequestTag} invocations. */
const flagRequestCommandNames = { help: "help", version: "version" } as const satisfies Record<
  FlagRequestTag,
  string
>;

/** The envelope command name used when no executable operation can be identified. */
export const unknownCommandName = "unknown";

/** Names the public operation that produces one invocation: its space-joined command path. */
export const commandNameOf = (tag: Invocation["_tag"]): string =>
  tag === "help" || tag === "version"
    ? flagRequestCommandNames[tag]
    : commandDeclarations[tag].path.join(" ");

/** The words after `tack` that select one invocation; the flag requests are selected by no word. */
export const commandPathOf = (tag: Invocation["_tag"]): ReadonlyArray<string> =>
  tag === "help" || tag === "version" ? [] : commandDeclarations[tag].path;

const commandNames: ReadonlySet<string> = new Set([
  ...Object.values(commandDeclarations).map(({ path }) => path.join(" ")),
  ...Object.values(flagRequestCommandNames),
]);

/** Reports whether a value is the public name of an executable operation. */
export const isCommandName = (value: unknown): value is string =>
  typeof value === "string" && commandNames.has(value);

/**
 * Names the executable operation selected by the words after `tack`, or {@link unknownCommandName}
 * when they select only a command group or nothing at all.
 */
export const commandNameOfPath = (path: ReadonlyArray<string>): string => {
  const name = path.join(" ");
  return isCommandName(name) ? name : unknownCommandName;
};
