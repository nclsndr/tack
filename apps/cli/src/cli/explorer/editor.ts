import { requireMutableChoice } from "../../features/choices/builtin-choice.ts";
import { requirePickable } from "../../features/choices/pick.ts";
import { Effect, type Context } from "effect";
import { listChoices, removeChoice, setChoice } from "../../features/choices/choice.ts";
import type { Namespace } from "../../domain/choices/choice-schema.ts";
import { attachDocs, detachDocs } from "../../features/docs/docs.ts";
import type { ReconcileCommandOptions } from "../../features/reconciliation/reconcile-command.ts";
import { planSync, runSyncCommand } from "../../features/reconciliation/sync-command.ts";
import type { ReconciliationAction } from "../../domain/reconciliation/reconciliation-schema.ts";
import {
  makeCommandSnapshot,
  readInvocationSnapshot,
} from "../../features/snapshot/command-snapshot.ts";
import { catalogReport } from "../../domain/sources/catalog-report.ts";
import { docsSettingsFor } from "../../domain/state/state-intent.ts";
import { withStateCheckpointWriter, type StateOptions } from "../../services/state-store.ts";
import { referencesOf } from "../human/catalog.ts";
import { withReferences, type Style } from "../human/style.ts";
import type { Catalog } from "../../domain/sources/catalog-schema.ts";
import { explorerActivity, scopeKey } from "./activity.ts";
import { publishedProfiles } from "./published-profiles.ts";
import { explorerEntries, labelledAddress } from "./entries.ts";
import { pendingText, stagedState, type PendingChange } from "./edit.ts";
import { unitSummary } from "../human/plan.ts";
import { namespaceText } from "../human/view.ts";
import type { ExplorerState, ExplorerEntry } from "./model.ts";
import type { RouteServices } from "../envelope/route-services.ts";
import { userExcludeCommand } from "../envelope/command-line.ts";
import type { State } from "../../domain/state/state-schema.ts";

/** The effects the session runs for edit mode, with every service already provided. */
export type ExplorerEditor = {
  /** Plans the staged changes against an in-memory state. Writes nothing. */
  readonly preview: (pending: ReadonlyArray<PendingChange>) => Effect.Effect<ReadonlyArray<string>>;
  /** Persists the staged changes, applies the sync, and reloads the entries. */
  readonly apply: (pending: ReadonlyArray<PendingChange>) => Effect.Effect<{
    readonly nextState?: ExplorerState;
    readonly lines: ReadonlyArray<string>;
    /** The reloaded entries; absent when reloading failed, so the list keeps what it had. */
    readonly entries: ReadonlyArray<ExplorerEntry> | undefined;
  }>;
};

/** A published profile the explorer edits; its line in every state block is marked. */
type EditedProfile = {
  readonly _tag: "profile";
  readonly sourcePath: string;
  readonly profileName: string;
};

/**
 * Loads the catalog report and the explorer entries, with edit state when a user or project
 * namespace is given. `fixedBy` names the profile that fixes that namespace, if one does. A
 * profile destination only marks its own line; its editor sets the membership rows.
 */
export const loadExplorer = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  style: Style,
  destination: Namespace | EditedProfile | undefined,
) {
  const snapshot = yield* readInvocationSnapshot(stateOptions);
  const { state } = snapshot;
  const catalog = yield* snapshot.catalog;
  const report = catalogReport(catalog, { declaredBy: true });
  const choices = yield* listChoices(state);
  const destinations = explorerActivity(
    state,
    catalog,
    yield* publishedProfiles(snapshot, catalog),
  );
  if (destination === undefined || destination._tag === "profile")
    return {
      report,
      entries: explorerEntries(
        report,
        choices,
        style.path,
        undefined,
        destinations,
        destination === undefined ? undefined : scopeKey(destination),
      ),
    };
  // Listing the namespace first reports an unregistered project before the session opens.
  yield* listChoices(state, destination);
  const attachments =
    destination._tag === "project"
      ? (docsSettingsFor(state, destination.projectName)?.attachments ?? [])
      : [];
  const fixedBy = destinations.find(
    (item) => scopeKey(item.scope) === scopeKey(destination),
  )?.fixedBy;
  return {
    report,
    entries: explorerEntries(
      report,
      choices,
      style.path,
      { namespace: destination, attachments },
      destinations,
    ),
    ...(fixedBy === undefined ? {} : { fixedBy }),
  };
});

const describe = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const record = error as { readonly message?: unknown; readonly _tag?: unknown };
    if (typeof record.message === "string" && record.message.length > 0) return record.message;
    if (typeof record._tag === "string") return record._tag;
  }
  return String(error);
};

const relativeTo = (root: string, path: string, style: Style) =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : style.path(path);

/** Names a resource by its source label, as the details panel does. */
const labelled = (address: Parameters<typeof labelledAddress>[0], style: Style) =>
  labelledAddress(address, style.source);

const actionLine = (
  action: ReconciliationAction,
  root: string,
  style: Style,
): string | undefined => {
  if (action._tag === "directory-create")
    return `  create dir  ${relativeTo(root, action.directoryPath, style)}/`;
  if (action._tag === "link-create")
    return `  ${action.previousEvidence === undefined ? "link   " : "replace"}     ${relativeTo(root, action.destinationPath, style)}  ${labelled(action.evidence.address, style)}`;
  if (action._tag === "link-remove")
    return `  unlink      ${relativeTo(root, action.destinationPath, style)}  ${labelled(action.evidence.address, style)} (${action.reason})`;
  if (action._tag === "link-adopt")
    return `  adopt       ${relativeTo(root, action.destinationPath, style)}  ${labelled(action.evidence.address, style)} (already linked)`;
  return `  forget      ${relativeTo(root, action.destinationPath, style)}  record only`;
};

const changeLines = (pending: ReadonlyArray<PendingChange>, namespace: Namespace, style: Style) => [
  `Staged changes in ${namespaceText(namespace, "prose")}`,
  ...pending.map((change) =>
    change.kind === "docs"
      ? `  ${pendingText(change)}  ${labelled({ kind: "docs", ...change.resource }, style)}`
      : `  ${pendingText(change)}  ${labelled(change.address, style)}`,
  ),
];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Builds the edit-mode effects. Previews plan against `stagedState`, so nothing is persisted until
 * `apply`, which uses the same choice, docs and reconcile operations as the matching commands.
 */
export const makeExplorerEditor = (options: {
  readonly stateOptions: StateOptions;
  readonly namespace: Namespace;
  readonly style: Style;
  readonly cwd: string;
  readonly context: Context.Context<RouteServices>;
}): ExplorerEditor => {
  const { stateOptions, namespace, context } = options;
  // Resources are named by their source label in the catalog each preview or apply reads.
  const named = (catalog: Catalog) =>
    withReferences(options.style, referencesOf(catalogReport(catalog)));
  const run = <A, E>(effect: Effect.Effect<A, E, RouteServices>) =>
    Effect.provideContext(effect, context);
  // The same selection `tack sync --project <name>` or `tack sync --user` makes.
  const syncOptions: ReconcileCommandOptions & { readonly noDocs: boolean } = {
    apply: false,
    cwd: options.cwd,
    includeOptional: false,
    noDocs: false,
    selector:
      namespace._tag === "user"
        ? { _tag: "user" }
        : { _tag: "project", projectName: namespace.projectName },
  };
  const projectName = namespace._tag === "project" ? namespace.projectName : undefined;
  // The checks `tack pick` runs, on every staged choice before the first write, so a refused
  // change leaves no half-saved batch. A reset only needs the resource to be mutable.
  const requireBatch = Effect.fnUntraced(function* (
    catalog: Catalog,
    state: State,
    pending: ReadonlyArray<PendingChange>,
  ) {
    for (const change of pending)
      if (change.kind === "choice")
        yield* change.decision === "unset"
          ? requireMutableChoice(catalog, change.address)
          : requirePickable(
              catalog,
              state,
              { address: change.address, decision: change.decision, namespace },
              userExcludeCommand,
            );
  });

  const preview: ExplorerEditor["preview"] = (pending) =>
    run(
      Effect.gen(function* () {
        const current = yield* readInvocationSnapshot(stateOptions);
        const catalog = yield* current.catalog;
        const style = named(catalog);
        yield* requireBatch(catalog, current.state, pending);
        // Staging changes picks and docs, never sources, so the staged snapshot shares the catalog.
        const staged = yield* makeCommandSnapshot(
          stagedState(current.state, namespace, pending),
          current,
        );
        const plan = yield* planSync(stateOptions, syncOptions, staged);
        const lines = [
          ...changeLines(pending, namespace, style),
          "",
          "Nothing has been written. This is the plan tack sync would apply:",
        ];
        const prepared = plan.resources;
        for (const unit of prepared?.plan.units ?? []) {
          lines.push(
            `${unit.adapter} → ${unit.target._tag === "user" ? "user" : unit.target.projectName}: ${unitSummary(unit)}`,
          );
          for (const action of unit.actions) {
            const line = actionLine(action, unit.target.canonicalPath, style);
            if (line !== undefined) lines.push(line);
          }
          for (const address of unit.linkedForUser ?? [])
            lines.push(`  skip        ${labelled(address, style)} (linked for the user)`);
          for (const conflict of unit.conflicts)
            lines.push(
              `  conflict    ${
                "destinationPath" in conflict
                  ? `${relativeTo(unit.target.canonicalPath, conflict.destinationPath, style)}  `
                  : ""
              }${conflict._tag} (left untouched)`,
            );
        }
        if (prepared !== undefined && prepared.plan.units.length === 0)
          lines.push("No adapter and target to plan for (see tack adapter).");
        // A conflict already named above says what its cause code would.
        const conflictTags = new Set<string>(
          (prepared?.plan.units ?? []).flatMap((unit) => unit.conflicts.map(({ _tag }) => _tag)),
        );
        for (const cause of prepared?.causes ?? [])
          if (!conflictTags.has(cause.code)) lines.push(`  note        ${cause.code}`);
        const docsActions = plan.docs.flatMap((entry) => entry.actions);
        const docsIssues = plan.docs.flatMap((entry) => entry.issues);
        if (docsActions.length > 0 || docsIssues.length > 0) {
          lines.push("", "Docs mounts:");
          for (const action of docsActions)
            lines.push(
              `  ${action.action.padEnd(11)} ${relativeTo(action.evidence.root, action.evidence.destinationPath, style)}`,
            );
          for (const issue of docsIssues) lines.push(`  note        ${issue.code}`);
        }
        return lines;
      }),
    ).pipe(
      Effect.catch((error) => Effect.succeed([`Cannot preview these changes: ${describe(error)}`])),
    );

  const apply: ExplorerEditor["apply"] = Effect.fnUntraced(function* (pending) {
    const lines: Array<string> = [];
    const failure = yield* run(
      Effect.gen(function* () {
        const snapshot = yield* readInvocationSnapshot(stateOptions);
        const catalog = yield* snapshot.catalog;
        const style = named(catalog);
        // Validate the whole batch before its first write, including forged or stale staging.
        yield* requireBatch(catalog, snapshot.state, pending);
        for (const change of pending) {
          if (change.kind === "choice") {
            if (change.decision === "unset")
              yield* withStateCheckpointWriter(stateOptions, (writer) =>
                removeChoice(writer, { address: change.address, namespace }),
              );
            else {
              const { decision } = change;
              yield* withStateCheckpointWriter(stateOptions, (writer) =>
                setChoice(writer, { address: change.address, decision, namespace }),
              );
            }
            lines.push(`saved   ${pendingText(change)} ${labelled(change.address, style)}`);
          } else if (change.kind === "docs" && projectName !== undefined) {
            const request = {
              reference: `${change.resource.sourceRegistrationId}:${change.resource.name}`,
            };
            yield* change.attached
              ? attachDocs(stateOptions, { projectName }, request)
              : detachDocs(stateOptions, { projectName }, request);
            lines.push(`saved   ${pendingText(change)} docs ${change.resource.name}`);
          }
        }
        const result = yield* runSyncCommand(stateOptions, { ...syncOptions, apply: true });
        const outcomes = (result.applied?.resources?.units ?? []).flatMap((unit) => unit.actions);
        const count = (tag: "applied" | "failed" | "skipped") =>
          outcomes.filter((outcome) => outcome._tag === tag).length;
        // Foreign destinations are never replaced; say so instead of reporting nothing to do.
        const left = (result.plan.resources?.plan.units ?? []).reduce(
          (total, { summary }) => total + summary.conflict + summary.collision + summary.blocked,
          0,
        );
        lines.push(
          outcomes.length === 0 && left === 0
            ? "skills  nothing to link or remove"
            : `skills  ${[
                ...(outcomes.length === 0
                  ? []
                  : [
                      `${count("applied")} applied, ${count("failed")} failed, ${count("skipped")} skipped`,
                    ]),
                ...(left === 0 ? [] : [`${plural(left, "conflict")} left unchanged`]),
              ].join(", ")}`,
        );
        for (const outcome of outcomes)
          if (outcome._tag === "failed") lines.push(`  failed ${outcome.code}: ${outcome.message}`);
        const docs = (result.applied?.docs ?? []).flatMap((entry) => entry.actions);
        if (docs.length > 0)
          lines.push(
            `docs    ${docs.filter((outcome) => outcome._tag === "applied").length} applied, ${docs.filter((outcome) => outcome._tag !== "applied").length} not applied`,
          );
        for (const outcome of docs)
          if (outcome._tag === "failed" || outcome._tag === "blocked")
            lines.push(`  ${outcome._tag} ${outcome.message}`);
        return undefined;
      }),
    ).pipe(Effect.catch((error) => Effect.succeed(describe(error))));
    if (failure !== undefined)
      lines.push(`stopped ${failure}`, "Changes saved before this point remain; rerun to finish.");
    const entries = yield* run(
      loadExplorer(stateOptions, options.style, namespace).pipe(
        Effect.map((loaded) => loaded.entries),
      ),
    ).pipe(Effect.catch(() => Effect.succeed(undefined)));
    return { lines, entries };
  });

  return { preview, apply };
};
