import { Effect, FileSystem, Path } from "effect";
import {
  docsLink,
  type DocsManagedLink,
  type DocsResourceReference,
  type DocsResourceRequest,
  managedDocsLinksOf,
} from "../../src/domain/docs/docs-schema.ts";
import { journalOf } from "../../src/domain/state/state-journal.ts";
import type { State } from "../../src/domain/state/state-schema.ts";
import { registerSource } from "../../src/features/sources/source.ts";
import { initializeState, type StateOptions } from "../../src/services/state-store.ts";
import { syncDocs } from "./reconciliation.ts";
import { mutateStateFixture } from "./state-fixture.ts";

/** The temporary world of a docs test. */
export type DocsWorld = {
  readonly options: StateOptions;
  readonly root: string;
  readonly sourceId: string;
  readonly source: string;
  readonly roots: string[];
};

/**
 * Runs `use` in a fresh world: an initialized state, a project `demo` with the two roots
 * `project-a` and `project-b`, and a registered source that declares the docs `handbook`.
 */
export const withDocsWorld = <A, E, R>(use: (world: DocsWorld) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-docs-" }));
    const options = {
      environment: { TACK_STATE_DIR: path.join(root, "state") },
      homeDirectory: root,
    };
    yield* initializeState(options);
    const roots = [path.join(root, "project-a"), path.join(root, "project-b")];
    for (const directory of roots) yield* fs.makeDirectory(directory);
    yield* mutateStateFixture(options, (state) => ({
      ...state,
      data: {
        ...state.data,
        projects: [{ name: "demo", gitCommonDirectory: path.join(root, "git"), roots }],
      },
    }));
    const source = path.join(root, "source");
    yield* fs.makeDirectory(path.join(source, "knowledge"), { recursive: true });
    yield* fs.writeFileString(
      path.join(source, "tack.yaml"),
      "version: 1\ndocs:\n  - name: handbook\n    path: knowledge\n",
    );
    yield* fs.writeFileString(path.join(source, "knowledge", "hello.md"), "# Hello\n");
    const registered = yield* registerSource(options, { sourcePath: source });
    return yield* use({ options, root, sourceId: registered.registration.id, source, roots });
  });

/** Names a known docs reference the way an operator passes it, with its source registration ID. */
export const docsRequest = (resource: DocsResourceReference): DocsResourceRequest => ({
  reference: `${resource.sourceRegistrationId}:${resource.name}`,
});

/** The report a docs sync ends with: its application when one ran, otherwise its plan. */
export const syncDocsReport = (...args: Parameters<typeof syncDocs>) =>
  syncDocs(...args).pipe(Effect.map((execution) => execution.applied ?? execution.plan));

/** The docs mounts a state records. */
export const docsEvidence = (state: State) => managedDocsLinksOf(state.data.links);

/** The docs journal entry a state still holds. */
export const docsJournal = (state: State) =>
  journalOf(state).find((entry) => entry.link.delivery._tag === "docs");

/** Swaps the docs mounts of a state for the given ones, keeping every other link. */
export const replaceDocsLinks = (state: State, mounts: ReadonlyArray<DocsManagedLink>) => [
  ...state.data.links.filter((link) => link.delivery._tag !== "docs"),
  ...mounts.map((mount) => docsLink(mount)),
];
