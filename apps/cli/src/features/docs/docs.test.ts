import { resolveCatalogAt } from "../../../test/support/snapshot-helpers.ts";
import { mutateStateFixture } from "../../../test/support/state-fixture.ts";
import { allDocsSettings } from "../../domain/state/state-intent.ts";
import { expect, it } from "@effect/vitest";
import { chmodSync } from "node:fs";
import { Effect, FileSystem, Path, Schema } from "effect";
import { loadProjectCorpus } from "@tackup/reader/search";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { readState } from "../../services/state-store.ts";
import { StateSchema } from "../../domain/state/state-schema.ts";
import { registerSource } from "../sources/source.ts";
import { Destination } from "../../services/destination.ts";
import {
  docsLink,
  docsRelativeTarget,
  reportDocsManagedLink,
} from "../../domain/docs/docs-schema.ts";
import { withCommandWriter } from "../writer/recovered-writer.ts";
import { runSyncCommand } from "../reconciliation/sync-command.ts";
import { syncDocs } from "../../../test/support/reconciliation.ts";
import {
  docsEvidence,
  docsJournal,
  docsRequest,
  replaceDocsLinks,
  syncDocsReport,
  withDocsWorld,
} from "../../../test/support/docs-world.ts";

import {
  attachDocs,
  detachDocs,
  configureDocs,
  inspectDocs,
  resolveDocsTarget,
  resolveProjectDocs,
} from "./docs.ts";

it.layer(LiveTestLayer)("registered docs", (test) => {
  test.effect("passes inline and linked YAML reader settings through the registered catalog", () =>
    withDocsWorld(({ options, source, sourceId }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(path.join(source, "knowledge", "hidden.md"), "# Hidden\n");
        // Each docs entry owns its folder, so the linked settings filter a copy of the same files.
        for (const folder of ["linked", "invalid"]) {
          yield* fs.makeDirectory(path.join(source, folder));
          for (const title of ["Hello", "Hidden"])
            yield* fs.writeFileString(
              path.join(source, folder, `${title.toLowerCase()}.md`),
              `# ${title}\n`,
            );
        }
        yield* fs.makeDirectory(path.join(source, "reader"));
        yield* fs.writeFileString(
          path.join(source, "reader", "handbook.yaml"),
          "content:\n  - root: linked\n    exclude: [hello.md]\n",
        );
        yield* fs.writeFileString(
          path.join(source, "tack.yaml"),
          "version: 1\nname: source\ndocs:\n  - name: handbook\n    path: knowledge\n    reader:\n      content:\n        - root: knowledge\n          exclude: [hidden.md]\n  - name: linked\n    path: linked\n    reader: reader/handbook.yaml\n  - name: invalid\n    path: invalid\n    reader: reader/handbook.json\n",
        );
        for (const name of ["handbook", "linked", "invalid"]) {
          yield* attachDocs(
            options,
            { projectName: "demo" },
            docsRequest({
              sourceRegistrationId: sourceId,

              name,
            }),
          );
        }
        const input = yield* resolveProjectDocs(options, { projectName: "demo" });
        expect(input.resources).toHaveLength(3);
        const corpus = yield* Effect.promise(() => loadProjectCorpus(input));
        expect(corpus.documents.map((doc) => [doc.title, doc.resource?.name])).toEqual([
          ["Hello", "handbook"],
          ["Hidden", "linked"],
        ]);
        expect(corpus.issues).toMatchObject([
          { resource: { name: "invalid" }, message: expect.stringContaining(".yaml or .yml") },
        ]);
      }),
    ),
  );
  test.effect(
    "keeps same-name resources from two sources and quarantines only a broken resource",
    () =>
      withDocsWorld(({ options, root }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sourcePath = path.join(root, "second");
          yield* fs.makeDirectory(path.join(sourcePath, "notes"), { recursive: true });
          yield* fs.writeFileString(
            path.join(sourcePath, "tack.yaml"),
            "version: 1\nname: second\ndocs:\n  - name: handbook\n    path: notes\n  - name: broken\n    path: missing\n",
          );
          yield* registerSource(options, { sourcePath });
          const catalog = yield* resolveCatalogAt(options);
          expect(catalog.entries.filter((entry) => entry.address.kind === "docs")).toHaveLength(2);
          expect(catalog.quarantined).toMatchObject([
            { address: { kind: "docs", name: "broken" } },
          ]);
          expect(catalog.unhealthySources).toEqual([]);
        }),
      ),
  );
  test.effect(
    "persists intent, previews, shares writes across roots, and cleans detached links",
    () =>
      withDocsWorld(({ options, sourceId, source, roots }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const resource = {
            sourceRegistrationId: sourceId,

            name: "handbook",
          };
          yield* attachDocs(options, { projectName: "demo" }, docsRequest(resource));
          yield* configureDocs(
            options,
            { projectName: "demo" },
            { defaultWritingResource: docsRequest(resource) },
          );
          const mount = path.join(roots[0] ?? "", ".tack/docs", sourceId, "handbook");
          expect(yield* fs.exists(mount)).toBe(false);
          const preview = yield* syncDocsReport(options, { projectName: "demo", apply: false });
          expect(preview.actions.filter((action) => action.action === "create")).toHaveLength(2);
          expect(yield* fs.exists(mount)).toBe(false);
          const execution = yield* syncDocs(options, { projectName: "demo", apply: true });
          // Apply reports the plan it built under the lock together with the applied result.
          expect(execution.plan).toEqual(preview);
          expect(execution.applied?.actions.map((outcome) => outcome.action.action)).toEqual([
            "create",
            "create",
          ]);
          const target = yield* resolveDocsTarget(options, { projectName: "demo" });
          expect(target.sourceDirectoryPath).toBe(path.join(source, "knowledge"));
          yield* fs.writeFileString(
            path.join(target.destinationPath, "shared.md"),
            "# Shared write\n",
          );
          expect(
            yield* fs.readFileString(
              path.join(roots[1] ?? "", ".tack/docs", sourceId, "handbook/shared.md"),
            ),
          ).toBe("# Shared write\n");
          expect(
            (yield* resolveProjectDocs(options, { cwd: roots[1] ?? "" })).resources,
          ).toHaveLength(1);
          yield* detachDocs(options, { projectName: "demo" }, docsRequest(resource));
          expect(
            allDocsSettings(yield* readState(options))?.[0]?.defaultWritingResource,
          ).toBeUndefined();
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          expect(yield* fs.exists(mount)).toBe(false);
          expect(yield* fs.exists(path.join(source, "knowledge/shared.md"))).toBe(true);
        }),
      ),
  );
  test.effect(
    "applies the other links and reports the failed one after a read-only destination",
    () =>
      withDocsWorld(({ options, root, roots, sourceId }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const thirdRoot = path.join(root, "project-c");
          yield* fs.makeDirectory(thirdRoot);
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              projects: (state.data.projects ?? []).map((project) => ({
                ...project,
                roots: [...project.roots, thirdRoot],
              })),
            },
          }));
          yield* attachDocs(
            options,
            { projectName: "demo" },
            docsRequest({ sourceRegistrationId: sourceId, name: "handbook" }),
          );
          const protectedParent = path.join(roots[1] ?? "", ".tack/docs", sourceId);
          yield* fs.makeDirectory(protectedParent, { recursive: true });
          chmodSync(protectedParent, 0o555);
          const execution = yield* syncDocs(options, {
            projectName: "demo",
            apply: true,
          }).pipe(Effect.ensuring(Effect.sync(() => chmodSync(protectedParent, 0o755))));
          expect(execution.plan.actions.map((action) => action.action)).toEqual([
            "create",
            "create",
            "create",
          ]);
          expect(execution.applied?.actions.map((outcome) => outcome._tag)).toEqual([
            "applied",
            "failed",
            "applied",
          ]);
          expect(execution.applied?.actions[1]).toMatchObject({
            code: "filesystem-failure",
          });
          // A failed destination settles on its own and blocks no other destination.
          expect(docsJournal(yield* readState(options))).toBeUndefined();
          expect(
            (yield* syncDocs(options, { projectName: "demo", apply: true })).applied,
          ).toMatchObject({ complete: true });
        }),
      ),
  );
  test.effect("refuses unmanaged matching links and preserves changed owned destinations", () =>
    withDocsWorld(({ options, sourceId, source, roots }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resource = {
          sourceRegistrationId: sourceId,

          name: "handbook",
        };
        yield* attachDocs(options, { projectName: "demo" }, docsRequest(resource));
        const mount = path.join(roots[0] ?? "", ".tack/docs", sourceId, "handbook");
        yield* fs.makeDirectory(path.dirname(mount), { recursive: true });
        yield* fs.symlink(
          path.relative(path.dirname(mount), path.join(source, "knowledge")),
          mount,
        );
        const result = yield* syncDocsReport(options, { projectName: "demo", apply: true });
        expect(result.complete).toBe(false);
        expect(docsEvidence(yield* readState(options))).toHaveLength(1);
        expect(
          yield* Effect.flip(
            resolveDocsTarget(options, { projectName: "demo", resource: docsRequest(resource) }),
          ),
        ).toMatchObject({ code: "docs-mount-unavailable" });
        yield* detachDocs(options, { projectName: "demo" }, docsRequest(resource));
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        expect(yield* fs.exists(mount)).toBe(true);
      }),
    ),
  );
  test.effect("moves the destination and preserves content when a detached source disappears", () =>
    withDocsWorld(({ options, sourceId, source, roots }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resource = {
          sourceRegistrationId: sourceId,

          name: "handbook",
        };
        yield* attachDocs(options, { projectName: "demo" }, docsRequest(resource));
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        const previous = path.join(roots[0] ?? "", ".tack/docs", sourceId, "handbook");
        yield* configureDocs(options, { projectName: "demo" }, { destination: "knowledge" });
        const applied = yield* syncDocsReport(options, { projectName: "demo", apply: true });
        expect(applied.complete).toBe(true);
        expect(yield* fs.exists(previous)).toBe(false);
        const next = path.join(roots[0] ?? "", "knowledge", sourceId, "handbook");
        expect(yield* fs.realPath(next)).toBe(path.join(source, "knowledge"));
        yield* detachDocs(options, { projectName: "demo" }, docsRequest(resource));
        yield* fs.remove(source, { recursive: true });
        expect(
          (yield* syncDocsReport(options, { projectName: "demo", apply: true })).complete,
        ).toBe(true);
        expect(docsEvidence(yield* readState(options))).toEqual([]);
      }),
    ),
  );
  test.effect("refuses writing and cleanup through a redirected destination parent", () =>
    withDocsWorld(({ options, sourceId, roots }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resource = {
          sourceRegistrationId: sourceId,

          name: "handbook",
        };
        yield* attachDocs(options, { projectName: "demo" }, docsRequest(resource));
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        const root = roots[0] ?? "";
        yield* fs.rename(path.join(root, ".tack"), path.join(root, "redirected"));
        yield* fs.symlink("redirected", path.join(root, ".tack"));
        expect(
          yield* Effect.flip(
            resolveDocsTarget(options, { projectName: "demo", resource: docsRequest(resource) }),
          ),
        ).toMatchObject({ code: "docs-mount-unavailable" });
        yield* detachDocs(options, { projectName: "demo" }, docsRequest(resource));
        expect(
          (yield* syncDocsReport(options, { projectName: "demo", apply: true })).complete,
        ).toBe(false);
        expect(docsEvidence(yield* readState(options))).toHaveLength(1);
      }),
    ),
  );
  test.effect("gives each planned docs conflict its own stable reason code", () =>
    withDocsWorld(({ options, sourceId, roots }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resource = { sourceRegistrationId: sourceId, name: "handbook" };
        const [rootA = "", rootB = ""] = roots;
        const mountOf = (root: string) => path.join(root, ".tack/docs", sourceId, "handbook");
        const conflictsOf = (report: {
          readonly actions: ReadonlyArray<{
            readonly action: string;
            readonly evidence: { readonly root: string };
            readonly code?: string;
          }>;
        }) =>
          report.actions.flatMap((entry) =>
            entry.action === "conflict" ? [[entry.evidence.root, entry.code]] : [],
          );
        yield* attachDocs(options, { projectName: "demo" }, docsRequest(resource));

        // An entry already sits at the destination; another root's parent is a file.
        yield* fs.makeDirectory(mountOf(rootA), { recursive: true });
        yield* fs.writeFileString(path.join(rootB, ".tack"), "not a directory");
        const planned = yield* syncDocs(options, { projectName: "demo", apply: true });
        const expected = [
          [rootA, "docs-destination-occupied"],
          [rootB, "docs-parent-not-directory"],
        ];
        expect(conflictsOf(planned.plan)).toEqual(expected);
        expect(
          planned.applied?.actions.flatMap((entry) =>
            entry._tag === "blocked" ? [[entry.action.evidence.root, entry.code]] : [],
          ),
        ).toEqual(expected);

        // Once the roots are clear, a symlinked parent and a changed link each report their own cause.
        yield* fs.remove(path.join(rootA, ".tack"), { recursive: true });
        yield* fs.remove(path.join(rootB, ".tack"));
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        yield* fs.rename(path.join(rootA, ".tack"), path.join(rootA, "redirected"));
        yield* fs.symlink("redirected", path.join(rootA, ".tack"));
        expect(
          conflictsOf((yield* syncDocs(options, { projectName: "demo", apply: false })).plan),
        ).toEqual([[rootA, "docs-parent-not-directory"]]);

        yield* detachDocs(options, { projectName: "demo" }, docsRequest(resource));
        yield* fs.remove(mountOf(rootB));
        yield* fs.symlink("elsewhere", mountOf(rootB));
        expect(
          conflictsOf((yield* syncDocs(options, { projectName: "demo", apply: false })).plan),
        ).toEqual([
          [rootA, "docs-parent-not-directory"],
          [rootB, "docs-destination-modified"],
        ]);
      }),
    ),
  );
  test.effect("recovers a prepared create and remove without adopting an unrelated link", () =>
    withDocsWorld(({ options, sourceId, root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resource = {
          sourceRegistrationId: sourceId,

          name: "handbook",
        };
        yield* attachDocs(options, { projectName: "demo" }, docsRequest(resource));
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        const evidence = docsEvidence(yield* readState(options))[0];
        if (evidence === undefined) return yield* Effect.die("Expected owned docs evidence");
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            links: replaceDocsLinks(
              state,
              docsEvidence(state).filter(
                (entry) => entry.destinationPath !== evidence.destinationPath,
              ) ?? [],
            ),
            journal: [{ _tag: "create", link: docsLink(evidence) }],
          },
        }));
        expect(
          (yield* syncDocsReport(options, { projectName: "demo", apply: true })).complete,
        ).toBe(true);
        expect(docsEvidence(yield* readState(options))).toHaveLength(2);
        const persisted = JSON.parse(
          yield* fs.readFileString(path.join(root, "state", "state.json")),
        );
        expect(persisted.data.docsProjects).toBeUndefined();
        expect(persisted.data.projects[0].docs.attachments).toEqual([resource]);
        expect(docsEvidence(persisted)).toHaveLength(2);
        expect(
          docsEvidence(persisted).every(
            (entry: Record<string, unknown>) => entry["relativeTarget"] === undefined,
          ),
        ).toBe(true);
        yield* detachDocs(options, { projectName: "demo" }, docsRequest(resource));
        yield* fs.remove(evidence.destinationPath);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: { ...state.data, journal: [{ _tag: "remove", link: docsLink(evidence) }] },
        }));
        expect(
          (yield* syncDocsReport(options, { projectName: "demo", apply: true })).complete,
        ).toBe(true);
        expect(docsEvidence(yield* readState(options))).toEqual([]);
        expect(docsJournal(yield* readState(options))).toBeUndefined();
        return undefined;
      }),
    ),
  );
  test.effect("rejects escaped docs evidence and non-canonical link text", () =>
    withDocsWorld(({ options, sourceId }) =>
      Effect.gen(function* () {
        yield* attachDocs(
          options,
          { projectName: "demo" },
          docsRequest({
            sourceRegistrationId: sourceId,

            name: "handbook",
          }),
        );
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        const state = yield* readState(options);
        const evidence = docsEvidence(state)[0];
        if (evidence === undefined) return yield* Effect.die("Expected owned docs evidence");
        expect(
          Schema.is(StateSchema)({
            ...state,
            data: {
              ...state.data,
              journal: [
                { _tag: "remove", link: docsLink({ ...evidence, destinationPath: "/unowned" }) },
              ],
            },
          }),
        ).toBe(false);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(evidence.destinationPath);
        yield* fs.symlink(`./${docsRelativeTarget(evidence)}`, evidence.destinationPath);
        const plan = yield* syncDocsReport(options, { projectName: "demo", apply: false });
        expect(plan.actions).toContainEqual(
          expect.objectContaining({
            action: "conflict",
            evidence: reportDocsManagedLink(evidence),
          }),
        );
        return undefined;
      }),
    ),
  );
  test.effect(
    "accepts name and folder alone while isolating malformed descriptors and same-source duplicates",
    () =>
      withDocsWorld(({ options, source }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(path.join(source, "skills", "example"), { recursive: true });
          for (const folder of ["first", "second"])
            yield* fs.makeDirectory(path.join(source, folder));
          yield* fs.writeFileString(
            path.join(source, "skills", "example", "SKILL.md"),
            "---\nname: example\ndescription: Mixed source skill.\n---\n# Example\n",
          );
          yield* fs.writeFileString(
            path.join(source, "tack.yaml"),
            "version: 1\nname: source\nskills:\n  - path: skills\ndocs:\n  - name: handbook\n    path: knowledge\n  - name: malformed\n    path: ../outside\n  - name: duplicate\n    path: first\n  - name: duplicate\n    path: second\n",
          );
          const catalog = yield* resolveCatalogAt(options);
          expect(catalog.unhealthySources).toEqual([]);
          expect(catalog.entries.map((entry) => entry.address.name).sort()).toEqual([
            "example",
            "handbook",
          ]);
          expect(catalog.quarantined).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                address: expect.objectContaining({ kind: "docs", name: "malformed" }),
              }),
            ]),
          );
          expect(
            catalog.quarantined.filter((entry) => entry.address?.name === "duplicate"),
          ).toHaveLength(2);
        }),
      ),
  );
  test.effect("resolves docs mutations to the project containing the cwd; --project wins", () =>
    withDocsWorld(({ options, sourceId, root, roots }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resource = {
          sourceRegistrationId: sourceId,

          name: "handbook",
        };
        const nested = path.join(roots[1] ?? "", "nested");
        yield* fs.makeDirectory(nested);
        yield* attachDocs(options, { cwd: nested }, docsRequest(resource));
        yield* configureDocs(
          options,
          { cwd: roots[0] ?? "" },
          { defaultWritingResource: docsRequest(resource) },
        );
        expect(allDocsSettings(yield* readState(options))).toMatchObject([
          { projectName: "demo", attachments: [resource], defaultWritingResource: resource },
        ]);
        const applied = yield* syncDocs(options, { cwd: roots[0] ?? "", apply: true });
        expect(
          applied.applied?.actions.filter((outcome) => outcome.action.action === "create"),
        ).toHaveLength(2);
        expect(
          yield* Effect.flip(attachDocs(options, { cwd: root }, docsRequest(resource))),
        ).toMatchObject({
          code: "bare-target-requires-registered-root",
        });
        expect(
          yield* Effect.flip(syncDocsReport(options, { cwd: root, apply: false })),
        ).toMatchObject({ code: "bare-target-requires-registered-root" });
        const otherRoot = path.join(root, "other");
        yield* fs.makeDirectory(otherRoot);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              ...(state.data.projects ?? []),
              {
                name: "other",
                gitCommonDirectory: path.join(root, "other-git"),
                roots: [otherRoot],
              },
            ],
          },
        }));
        yield* attachDocs(options, { projectName: "other", cwd: nested }, docsRequest(resource));
        yield* detachDocs(options, { cwd: nested }, docsRequest(resource));
        expect(
          allDocsSettings(yield* readState(options))?.map((entry) => [
            entry.projectName,
            entry.attachments.length,
          ]),
        ).toEqual([
          ["demo", 0],
          ["other", 1],
        ]);
      }),
    ),
  );
  test.effect(
    "selects a unique docs name without --source, by source path, and lists ambiguous candidates",
    () =>
      withDocsWorld(({ options, sourceId, source, root, roots }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const demo = { projectName: "demo", cwd: root };
          const handbook = { name: "handbook" };
          yield* attachDocs(options, demo, { reference: handbook.name });
          expect(allDocsSettings(yield* readState(options))?.[0]?.attachments).toEqual([
            { ...handbook, sourceRegistrationId: sourceId },
          ]);
          const second = path.join(root, "second");
          yield* fs.makeDirectory(path.join(second, "notes"), { recursive: true });
          yield* fs.writeFileString(
            path.join(second, "tack.yaml"),
            "version: 1\nname: second\ndocs:\n  - name: handbook\n    path: notes\n",
          );
          const secondId = (yield* registerSource(options, { sourcePath: second })).registration.id;
          const ambiguous = yield* Effect.flip(
            detachDocs(options, demo, { reference: handbook.name }),
          );
          expect(ambiguous).toMatchObject({
            code: "docs-resource-ambiguous",
            details: {
              name: "handbook",
              candidates: expect.arrayContaining([
                { ...handbook, sourceRegistrationId: sourceId, sourcePath: source },
                { ...handbook, sourceRegistrationId: secondId, sourcePath: second },
              ]),
            },
          });
          expect("details" in ambiguous ? ambiguous.details?.["candidates"] : []).toHaveLength(2);
          yield* attachDocs(options, demo, { reference: `second:${handbook.name}` });
          yield* configureDocs(options, demo, {
            defaultWritingResource: { reference: `second:${handbook.name}` },
          });
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          expect((yield* resolveDocsTarget(options, { cwd: roots[0] ?? "" })).resource).toEqual({
            ...handbook,
            sourceRegistrationId: secondId,
          });
          expect(
            (yield* resolveDocsTarget(options, {
              cwd: roots[0] ?? "",
              resource: { reference: `${sourceId}:${handbook.name}` },
            })).sourceDirectoryPath,
          ).toBe(path.join(source, "knowledge"));
          expect(
            yield* Effect.flip(
              attachDocs(options, demo, { reference: `missing:${handbook.name}` }),
            ),
          ).toMatchObject({
            code: "docs-source-not-registered",
            details: { source: "missing" },
          });
          expect(
            yield* Effect.flip(attachDocs(options, demo, { reference: "handbook" })),
          ).toMatchObject({ code: "docs-resource-ambiguous" });
          yield* detachDocs(options, demo, { reference: `${sourceId}:${handbook.name}` });
          expect(allDocsSettings(yield* readState(options))?.[0]).toMatchObject({
            attachments: [{ ...handbook, sourceRegistrationId: secondId }],
            defaultWritingResource: { ...handbook, sourceRegistrationId: secondId },
          });
        }),
      ),
  );
  test.effect(
    "targets a single attachment without a default and names the configure command otherwise",
    () =>
      withDocsWorld(({ options, sourceId, source, roots }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const demo = { projectName: "demo" };
          const unattached = yield* Effect.flip(resolveDocsTarget(options, demo));
          expect(unattached).toMatchObject({
            code: "docs-default-unset",
            message: expect.stringContaining("tack docs attach <name> --project demo"),
          });
          yield* attachDocs(options, demo, { reference: "handbook" });
          yield* syncDocsReport(options, { ...demo, apply: true });
          expect(yield* resolveDocsTarget(options, { cwd: roots[0] ?? "" })).toMatchObject({
            resource: { sourceRegistrationId: sourceId, name: "handbook" },
            sourceDirectoryPath: path.join(source, "knowledge"),
          });
          yield* fs.makeDirectory(path.join(source, "guide"));
          yield* fs.writeFileString(
            path.join(source, "tack.yaml"),
            "version: 1\nname: source\ndocs:\n  - name: handbook\n    path: knowledge\n  - name: guide\n    path: guide\n",
          );
          yield* attachDocs(options, demo, { reference: "guide" });
          const unset = yield* Effect.flip(resolveDocsTarget(options, demo));
          expect(unset).toMatchObject({
            code: "docs-default-unset",
            details: {
              projectName: "demo",
              candidates: [
                { sourceRegistrationId: sourceId, name: "guide" },
                { sourceRegistrationId: sourceId, name: "handbook" },
              ],
            },
          });
          for (const name of ["handbook", "guide"])
            expect(unset.message).toContain(`tack docs configure --project demo --default ${name}`);
        }),
      ),
  );
  test.effect("validates attachment/default intent and reports missing registered projects", () =>
    withDocsWorld(({ options, sourceId, root }) =>
      Effect.gen(function* () {
        const resource = {
          sourceRegistrationId: sourceId,

          name: "handbook",
        };
        expect(
          yield* Effect.flip(
            attachDocs(options, { projectName: "unknown" }, docsRequest(resource)),
          ),
        ).toMatchObject({
          _tag: "ProjectNotFoundError",
          code: "project-not-found",
          projectName: "unknown",
        });
        expect(
          yield* Effect.flip(
            attachDocs(
              options,
              { projectName: "demo" },
              docsRequest({ ...resource, name: "absent" }),
            ),
          ),
        ).toMatchObject({ code: "docs-resource-unavailable" });
        expect(
          yield* Effect.flip(
            attachDocs(
              options,
              { projectName: "demo" },
              docsRequest({ ...resource, name: "INVALID" }),
            ),
          ),
        ).toMatchObject({ code: "docs-resource-invalid" });
        expect(
          yield* Effect.flip(
            configureDocs(options, { projectName: "demo" }, { destination: "../outside" }),
          ),
        ).toMatchObject({ code: "docs-destination-invalid" });
        expect(
          yield* Effect.flip(
            configureDocs(
              options,
              { projectName: "demo" },
              { defaultWritingResource: docsRequest(resource) },
            ),
          ),
        ).toMatchObject({ code: "docs-default-not-attached" });
        expect(
          yield* Effect.flip(resolveDocsTarget(options, { projectName: "demo" })),
        ).toMatchObject({ code: "docs-default-unset" });
        expect(
          yield* Effect.flip(
            resolveDocsTarget(options, { projectName: "demo", resource: docsRequest(resource) }),
          ),
        ).toMatchObject({ code: "docs-resource-not-attached" });
        expect(yield* Effect.flip(resolveProjectDocs(options, { cwd: root }))).toMatchObject({
          _tag: "TargetSelectionError",
          code: "bare-target-requires-registered-root",
        });
        expect(
          yield* Effect.flip(resolveProjectDocs(options, { cwd: root, projectName: "unknown" })),
        ).toMatchObject({ _tag: "ProjectNotFoundError", projectName: "unknown" });
        expect(
          yield* Effect.flip(resolveProjectDocs(options, { cwd: root + "/missing" })),
        ).toMatchObject({ code: "docs-project-unavailable" });
        yield* attachDocs(options, { projectName: "demo" }, docsRequest(resource));
        yield* attachDocs(options, { projectName: "demo" }, docsRequest(resource));
        expect((yield* inspectDocs(options, { projectName: "demo" })).resources).toHaveLength(1);
        yield* configureDocs(
          options,
          { projectName: "demo" },
          { defaultWritingResource: docsRequest(resource) },
        );
        yield* configureDocs(options, { projectName: "demo" }, { clearDefault: true });
        expect(
          (yield* inspectDocs(options, { projectName: "demo" })).settings.defaultWritingResource,
        ).toBeUndefined();
      }),
    ),
  );
  test.effect(
    "retains unavailable attachments and links while exposing resource-addressed issues",
    () =>
      withDocsWorld(({ options, sourceId, source }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const resource = {
            sourceRegistrationId: sourceId,

            name: "handbook",
          };
          yield* attachDocs(options, { projectName: "demo" }, docsRequest(resource));
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          yield* fs.writeFileString(
            path.join(source, "tack.yaml"),
            "version: 1\nname: source\ndocs:\n  - name: handbook\n    path: ../invalid\n",
          );
          expect(
            (yield* resolveProjectDocs(options, { projectName: "demo" })).issues,
          ).toMatchObject([{ resource, code: "declaration-path-invalid" }]);
          expect(yield* inspectDocs(options, { projectName: "demo" })).toMatchObject({
            complete: false,
            resources: [],
            issues: [{ resource, code: "declaration-path-invalid" }],
          });
          expect(
            (yield* syncDocsReport(options, { projectName: "demo", apply: false })).complete,
          ).toBe(false);
          expect(docsEvidence(yield* readState(options))).toHaveLength(2);
          yield* fs.writeFileString(path.join(source, "tack.yaml"), "version: 1\nname: source\n");
          expect(
            (yield* resolveProjectDocs(options, { projectName: "demo" })).issues,
          ).toMatchObject([{ message: expect.stringContaining("no longer declared") }]);
          yield* fs.writeFileString(path.join(source, "tack.yaml"), "version: unsupported\n");
          expect(
            (yield* resolveProjectDocs(options, { projectName: "demo" })).issues,
          ).toMatchObject([{ message: "The registered source is unavailable." }]);
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: { ...state.data, sources: [] },
          }));
          expect(
            (yield* resolveProjectDocs(options, { projectName: "demo" })).issues,
          ).toMatchObject([{ sourcePath: "" }]);
        }),
      ),
  );
  test.effect("retains an old mount while its declaration is quarantined, then moves it", () =>
    withDocsWorld(({ options, source, sourceId, roots }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* attachDocs(
          options,
          { projectName: "demo" },
          docsRequest({
            sourceRegistrationId: sourceId,
            name: "handbook",
          }),
        );
        yield* syncDocsReport(options, { projectName: "demo", apply: true });
        const root = roots[0] ?? "";
        const current = path.join(root, ".tack/docs", sourceId, "handbook");
        const old = path.join(root, ".tack/docs", sourceId, "shared", "handbook");
        yield* fs.remove(current);
        yield* fs.makeDirectory(path.dirname(old), { recursive: true });
        yield* fs.symlink(path.relative(path.dirname(old), path.join(source, "knowledge")), old);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            links: replaceDocsLinks(
              state,
              docsEvidence(state).map((link) =>
                link.root === root ? { ...link, destinationPath: old } : link,
              ),
            ),
          },
        }));
        yield* fs.writeFileString(
          path.join(source, "tack.yaml"),
          "version: 1\nname: source\ndocs:\n  - name: handbook\n    extra: true\n    path: knowledge\n",
        );
        const unavailable = yield* syncDocs(options, { projectName: "demo", apply: false });
        expect(unavailable.plan.actions.some((action) => action.action === "remove")).toBe(false);
        expect(yield* fs.exists(old)).toBe(true);
        yield* fs.writeFileString(
          path.join(source, "tack.yaml"),
          "version: 1\nname: source\ndocs:\n  - name: handbook\n    path: knowledge\n",
        );
        const preview = yield* syncDocs(options, { projectName: "demo", apply: false });
        expect(preview.plan.actions.map((action) => action.action)).toContain("remove");
        expect(preview.plan.actions.map((action) => action.action)).toContain("create");
        yield* syncDocs(options, { projectName: "demo", apply: true });
        const settled = yield* syncDocs(options, { projectName: "demo", apply: false });
        expect(settled.plan.actions.every((action) => action.action === "keep")).toBe(true);
      }),
    ),
  );
  test.effect(
    "reports malformed docs lists and rejects foreign symlinks and non-directory targets",
    () =>
      withDocsWorld(({ options, source, root }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.writeFileString(
            path.join(source, "tack.yaml"),
            "version: 1\nname: source\ndocs: invalid\n",
          );
          expect((yield* resolveCatalogAt(options)).quarantined).toMatchObject([
            { code: "declaration-invalid" },
          ]);
          yield* fs.symlink(root, path.join(source, "escape"));
          yield* fs.writeFileString(path.join(source, "file"), "not a directory");
          yield* fs.writeFileString(
            path.join(source, "tack.yaml"),
            "version: 1\nname: source\ndocs:\n  - name: escape\n    path: escape\n  - name: file\n    path: file\n  - name: INVALID\n    path: knowledge\n  - name: handbook\n    path: knowledge\n    reader: custom.yaml\n",
          );
          const catalog = yield* resolveCatalogAt(options);
          expect(catalog.quarantined).toHaveLength(3);
          expect(catalog.entries).toMatchObject([
            {
              address: { name: "handbook" },
              readerConfig: { kind: "source", path: path.join(source, "tack.yaml") },
            },
          ]);
          yield* fs.remove(path.join(source, "tack.yaml"));
          const missing = yield* resolveCatalogAt(options);
          expect(missing.entries).toEqual([]);
          expect(missing.unhealthySources).toMatchObject([
            { issue: { code: "declaration-missing" }, registration: { canonicalPath: source } },
          ]);
        }),
      ),
  );
  test.effect(
    "does not restore an interrupted create over a replacement and blocks only the redirected destination",
    () =>
      withDocsWorld(({ options, sourceId, roots }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* attachDocs(
            options,
            { projectName: "demo" },
            docsRequest({
              sourceRegistrationId: sourceId,

              name: "handbook",
            }),
          );
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          const evidence = docsEvidence(yield* readState(options))[0];
          if (evidence === undefined) return yield* Effect.die("Expected docs evidence");
          yield* fs.remove(evidence.destinationPath);
          yield* fs.makeDirectory(evidence.destinationPath);
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              links: replaceDocsLinks(
                state,
                docsEvidence(state).filter(
                  (entry) => entry.destinationPath !== evidence.destinationPath,
                ) ?? [],
              ),
              journal: [{ _tag: "create", link: docsLink(evidence) }],
            },
          }));
          expect(
            (yield* syncDocsReport(options, { projectName: "demo", apply: true })).complete,
          ).toBe(false);
          expect(docsJournal(yield* readState(options))).toBeUndefined();
          const root = roots[0] ?? "";
          yield* fs.rename(path.join(root, ".tack"), path.join(root, "redirected"));
          yield* fs.symlink("redirected", path.join(root, ".tack"));
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: { ...state.data, journal: [{ _tag: "create", link: docsLink(evidence) }] },
          }));
          // The entry stays prepared and blocks its own destination; the other mount proceeds.
          const blocked = (yield* syncDocs(options, { projectName: "demo", apply: true })).applied;
          expect(blocked?.complete).toBe(false);
          expect(blocked?.actions.map((outcome) => outcome._tag)).toEqual(["skipped", "applied"]);
          expect(blocked?.actions[0]).toMatchObject({ reason: "recovery-pending" });
          expect(docsJournal(yield* readState(options))).toBeDefined();

          // Repairing the parent lets the next writer settle the entry by observation.
          yield* fs.remove(path.join(root, ".tack"));
          yield* fs.rename(path.join(root, "redirected"), path.join(root, ".tack"));
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          expect(docsJournal(yield* readState(options))).toBeUndefined();
          return undefined;
        }),
      ),
  );
  test.effect("resolves nested roots to the innermost project and keeps explicit roots", () =>
    withDocsWorld(({ options, roots }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outer = roots[1] ?? "";
        const inner = path.join(outer, "inner");
        const deeper = path.join(inner, "deeper");
        yield* fs.makeDirectory(deeper, { recursive: true });
        // "demo" sorts before "nested", so a first-match scan would claim the nested root.
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              ...(state.data.projects ?? []),
              { name: "nested", gitCommonDirectory: path.join(inner, ".git"), roots: [inner] },
            ],
          },
        }));
        const project = (selector: { readonly cwd: string; readonly projectName?: string }) =>
          resolveProjectDocs(options, selector).pipe(Effect.map((input) => input.project));

        expect(yield* project({ cwd: outer })).toEqual({ name: "demo", root: outer });
        expect(yield* project({ cwd: inner })).toEqual({ name: "nested", root: inner });
        expect(yield* project({ cwd: deeper })).toEqual({ name: "nested", root: inner });
        // An explicit project keeps the root containing the cwd rather than its first root.
        expect(yield* project({ cwd: deeper, projectName: "demo" })).toEqual({
          name: "demo",
          root: outer,
        });
      }),
    ),
  );
  test.effect("detects missing and redirected registered roots before reader selection", () =>
    withDocsWorld(({ options, roots, root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const selected = roots[0] ?? "";
        const moved = path.join(root, "moved-root");
        yield* fs.rename(selected, moved);
        expect(
          yield* Effect.flip(resolveProjectDocs(options, { projectName: "demo" })),
        ).toMatchObject({ code: "docs-project-unavailable" });
        yield* fs.symlink(moved, selected);
        expect(
          yield* Effect.flip(resolveProjectDocs(options, { projectName: "demo" })),
        ).toMatchObject({
          code: "docs-project-unavailable",
          message: expect.stringContaining("moved"),
        });
      }),
    ),
  );
  test.effect(
    "settles a creation or removal that cannot be verified by what its destination shows",
    () =>
      withDocsWorld(({ options, sourceId }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* attachDocs(
            options,
            { projectName: "demo" },
            docsRequest({
              sourceRegistrationId: sourceId,

              name: "handbook",
            }),
          );
          const create = yield* provideTestFileSystem(
            syncDocsReport(options, { projectName: "demo", apply: true }),
            {
              ...fs,
              symlink: () => Effect.void,
            },
          );
          expect(create.complete).toBe(false);
          expect(create.actions).toMatchObject([
            {
              _tag: "failed",
              code: "docs-verification-failed",
              message: expect.stringContaining("verified"),
            },
            { _tag: "failed", code: "docs-verification-failed" },
          ]);
          // Nothing was created, so no entry stays prepared and no evidence is recorded.
          expect(docsJournal(yield* readState(options))).toBeUndefined();
          expect(docsEvidence(yield* readState(options))).toEqual([]);
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          yield* detachDocs(
            options,
            { projectName: "demo" },
            docsRequest({
              sourceRegistrationId: sourceId,

              name: "handbook",
            }),
          );
          const remove = yield* provideTestFileSystem(
            syncDocsReport(options, { projectName: "demo", apply: true }),
            {
              ...fs,
              remove: (target, settings) =>
                target.includes("/handbook") ? Effect.void : fs.remove(target, settings),
            },
          );
          expect(remove.complete).toBe(false);
          // The link is still there and still owned, so its evidence is kept.
          expect(docsJournal(yield* readState(options))).toBeUndefined();
          expect(docsEvidence(yield* readState(options))).toHaveLength(2);
          expect(
            (yield* syncDocsReport(options, { projectName: "demo", apply: true })).complete,
          ).toBe(true);
        }),
      ),
  );
  test.effect("refuses to mutate a destination that changed after planning", () =>
    withDocsWorld(({ options, sourceId }) =>
      Effect.gen(function* () {
        const destination = yield* Destination;
        yield* attachDocs(
          options,
          { projectName: "demo" },
          docsRequest({
            sourceRegistrationId: sourceId,

            name: "handbook",
          }),
        );
        const seen = new Map<string, number>();
        const changed = Destination.of({
          linkDirectory: destination.linkDirectory,
          observe: (target) => {
            if (target.endsWith("/handbook")) {
              const count = (seen.get(target) ?? 0) + 1;
              seen.set(target, count);
              if (count === 2)
                return Effect.succeed({
                  _tag: "entry" as const,
                  destinationPath: target,
                  entryType: "directory" as const,
                });
            }
            return destination.observe(target);
          },
        });
        const result = yield* syncDocsReport(options, { projectName: "demo", apply: true }).pipe(
          Effect.provideService(Destination, changed),
        );
        expect(result.complete).toBe(false);
        expect(result.actions).toMatchObject([
          {
            _tag: "failed",
            code: "docs-destination-changed",
            message: expect.stringContaining("after planning"),
          },
          { _tag: "failed", code: "docs-destination-changed" },
        ]);
        expect(docsEvidence(yield* readState(options))).toEqual([]);
        expect(
          (yield* syncDocsReport(options, { projectName: "demo", apply: true })).complete,
        ).toBe(true);
      }),
    ),
  );
  test.effect("rejects a source directory redirected after planning", () =>
    withDocsWorld(({ options, sourceId, source, root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* attachDocs(
          options,
          { projectName: "demo" },
          docsRequest({
            sourceRegistrationId: sourceId,

            name: "handbook",
          }),
        );
        let reads = 0;
        const changed = {
          ...fs,
          realPath: (target: string) => {
            if (target === path.join(source, "knowledge")) {
              reads += 1;
              if (reads > 1) return Effect.succeed(root);
            }
            return fs.realPath(target);
          },
        };
        const result = yield* provideTestFileSystem(
          syncDocsReport(options, { projectName: "demo", apply: true }),
          changed,
        );
        expect(result.complete).toBe(false);
        expect(result.actions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message: "The docs directory changed after planning." }),
          ]),
        );
        expect(docsEvidence(yield* readState(options))).toEqual([]);
      }),
    ),
  );
  test.effect(
    "keeps a prepared docs entry under a redirected parent blocked while sync and other writers proceed",
    () =>
      withDocsWorld(({ options, sourceId, roots, root }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* attachDocs(
            options,
            { projectName: "demo" },
            docsRequest({ sourceRegistrationId: sourceId, name: "handbook" }),
          );
          yield* syncDocsReport(options, { projectName: "demo", apply: true });
          const evidence = docsEvidence(yield* readState(options)).find(
            (entry) => entry.root === roots[0],
          );
          if (evidence === undefined) return yield* Effect.die("Expected docs evidence");
          const blockedRoot = roots[0] ?? "";
          yield* fs.rename(path.join(blockedRoot, ".tack"), path.join(blockedRoot, "redirected"));
          yield* fs.symlink("redirected", path.join(blockedRoot, ".tack"));
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: { ...state.data, journal: [{ _tag: "create", link: docsLink(evidence) }] },
          }));

          // Every mutating command starts by recovering, and none of them fails on the blocked entry.
          expect(yield* withCommandWriter(options, () => Effect.succeed("proceeded"))).toBe(
            "proceeded",
          );
          expect(docsJournal(yield* readState(options))).toBeDefined();

          // sync applies the other destination and reports the blocked one.
          const sync = yield* runSyncCommand(options, {
            apply: true,
            cwd: root,
            includeOptional: false,
            noDocs: false,
            selector: { _tag: "all" },
          });
          expect(
            sync.applied?.docs.map((entry) => entry.actions.map((outcome) => outcome._tag)),
          ).toEqual([["skipped", "applied"]]);
          expect(docsJournal(yield* readState(options))).toBeDefined();
          return undefined;
        }),
      ),
  );
});
