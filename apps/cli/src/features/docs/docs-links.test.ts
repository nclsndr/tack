import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { makeLinkLedger } from "../links/link-engine.ts";
import { applyDocsActions, removeDocsMounts } from "./docs-links.ts";
import {
  docsLink,
  docsRelativeTarget,
  reportDocsManagedLink,
  type DocsLinkAction,
  type DocsManagedLink,
} from "../../domain/docs/docs-schema.ts";

/*
 * How a docs mount's create and remove end for each way the engine can refuse or fail, in the
 * terms the docs reports use. The engine decides; this file checks what each refusal is called.
 */

const registrationId = "00000000-0000-4000-8000-000000000001";

type World = {
  readonly mount: DocsManagedLink;
  readonly other: string;
  readonly source: string;
  readonly text: string;
};

const withWorld = <A, E, R>(use: (world: World) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-docs-links-" }),
    );
    const root = path.join(base, "project");
    const source = path.join(base, "source");
    const other = path.join(base, "other");
    yield* Effect.forEach([root, source, other], (directory) =>
      fileSystem.makeDirectory(directory, { recursive: true }),
    );
    const mount: DocsManagedLink = {
      projectName: "demo",
      root,
      resource: { sourceRegistrationId: registrationId, name: "handbook" },
      destinationPath: path.join(root, ".tack", "docs", registrationId, "handbook"),
      sourceDirectoryPath: source,
    };
    return yield* use({ mount, other, source, text: docsRelativeTarget(mount) });
  });

const actionOf = (action: "create" | "remove", mount: DocsManagedLink): DocsLinkAction => ({
  action,
  evidence: reportDocsManagedLink(mount),
});

const apply = (action: DocsLinkAction) =>
  applyDocsActions(makeLinkLedger(), { actions: [action], issues: [] }).pipe(
    Effect.map((result) => result.actions[0]),
  );

it.layer(LiveTestLayer)("docs outcomes of the one link engine", (docs) => {
  docs.effect("reports a create that a parent, the source or the destination refuses", () =>
    withWorld(({ mount, other, source }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const create = actionOf("create", mount);

        // The source is a file, then a missing path: the docs directory changed after planning.
        yield* fileSystem.remove(source, { recursive: true });
        expect(yield* apply(create)).toMatchObject({
          _tag: "failed",
          code: "filesystem-failure",
        });
        yield* fileSystem.writeFileString(source, "not a directory");
        expect(yield* apply(create)).toMatchObject({
          _tag: "failed",
          code: "docs-source-changed",
          message: "The docs directory changed after planning.",
        });
        yield* fileSystem.remove(source);
        yield* fileSystem.makeDirectory(source);

        // The destination is taken.
        yield* fileSystem.makeDirectory(mount.destinationPath, { recursive: true });
        expect(yield* apply(create)).toMatchObject({
          _tag: "failed",
          code: "docs-destination-changed",
        });
        yield* fileSystem.remove(mount.destinationPath, { recursive: true });

        // A parent that is a link is refused with its own cause, and nothing is created through it.
        yield* fileSystem.remove(path.join(mount.root, ".tack"), { recursive: true });
        yield* fileSystem.symlink(other, path.join(mount.root, ".tack"));
        expect(yield* apply(create)).toMatchObject({
          _tag: "failed",
          code: "docs-parent-not-directory",
        });
      }),
    ),
  );

  docs.effect("reports a create whose symlink fails", () =>
    withWorld(({ mount }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        expect(
          yield* provideTestFileSystem(apply(actionOf("create", mount)), {
            ...fileSystem,
            symlink: (target) => fileSystem.symlink(target, "/nonexistent-directory/link"),
          }),
        ).toMatchObject({ _tag: "failed", code: "filesystem-failure" });
      }),
    ),
  );

  docs.effect("reports a remove that is refused, unverified or failed", () =>
    withWorld(({ mount, other, text }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const remove = actionOf("remove", mount);
        yield* fileSystem.makeDirectory(path.dirname(mount.destinationPath), { recursive: true });

        // Not owned: the recorded link was replaced by something else.
        yield* fileSystem.makeDirectory(mount.destinationPath);
        expect(yield* apply(remove)).toMatchObject({
          _tag: "failed",
          code: "docs-destination-changed",
        });
        yield* fileSystem.remove(mount.destinationPath, { recursive: true });

        // The unlink did nothing, or failed: the link is still there.
        yield* fileSystem.symlink(text, mount.destinationPath);
        expect(
          yield* provideTestFileSystem(apply(remove), {
            ...fileSystem,
            remove: () => Effect.void,
          }),
        ).toMatchObject({ _tag: "failed", code: "docs-verification-failed" });
        expect(
          yield* provideTestFileSystem(apply(remove), {
            ...fileSystem,
            remove: (target) => fileSystem.remove(target + "-missing"),
          }),
        ).toMatchObject({ _tag: "failed", code: "filesystem-failure" });

        // An unsafe parent keeps a present link from being unlinked through it.
        yield* fileSystem.remove(path.join(mount.root, ".tack"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(other, "docs", registrationId), {
          recursive: true,
        });
        yield* fileSystem.symlink(other, path.join(mount.root, ".tack"));
        yield* fileSystem.symlink(
          docsRelativeTarget({
            destinationPath: path.join(other, "docs", registrationId, "handbook"),
            sourceDirectoryPath: mount.sourceDirectoryPath,
          }),
          path.join(other, "docs", registrationId, "handbook"),
        );
        expect(yield* apply(remove)).toMatchObject({
          _tag: "failed",
          code: "docs-parent-not-directory",
        });
      }),
    ),
  );

  docs.effect("keeps a mount whose removal cannot be made safely as an owed removal", () =>
    withWorld(({ mount, other, text }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const evidence = [reportDocsManagedLink(mount)];
        const ledger = () => makeLinkLedger();
        const removeAll = (use: ReturnType<typeof ledger>) => removeDocsMounts(use, evidence);
        yield* fileSystem.makeDirectory(path.dirname(mount.destinationPath), { recursive: true });

        // Gone already, or an owned link: settled.
        const gone = ledger();
        expect(yield* removeAll(gone)).toMatchObject([{ _tag: "applied" }]);
        expect(gone.changes).toMatchObject([{ _tag: "settle" }]);
        yield* fileSystem.symlink(text, mount.destinationPath);
        expect(yield* removeAll(ledger())).toMatchObject([{ _tag: "applied" }]);

        // Replaced by a directory: blocked with the observation as the reason.
        yield* fileSystem.makeDirectory(mount.destinationPath);
        const blocked = ledger();
        expect(yield* removeAll(blocked)).toMatchObject([
          {
            _tag: "blocked",
            code: "docs-destination-modified",
            message: "The destination is an existing directory.",
          },
        ]);
        expect(blocked.changes).toMatchObject([
          { _tag: "result", lastResult: { _tag: "blocked" } },
        ]);
        yield* fileSystem.remove(mount.destinationPath, { recursive: true });

        // The unlink did nothing: the destination is still there, which is blocked too.
        yield* fileSystem.symlink(text, mount.destinationPath);
        expect(
          yield* provideTestFileSystem(removeAll(ledger()), {
            ...fileSystem,
            remove: () => Effect.void,
          }),
        ).toMatchObject([{ _tag: "blocked", code: "docs-destination-modified" }]);

        // The unlink fails: a failure, recorded as the last result.
        const failing = ledger();
        expect(
          yield* provideTestFileSystem(removeAll(failing), {
            ...fileSystem,
            remove: (target) => fileSystem.remove(target + "-missing"),
          }),
        ).toMatchObject([{ _tag: "failed", code: "filesystem-failure" }]);
        expect(failing.changes).toMatchObject([
          { _tag: "result", lastResult: { _tag: "filesystem-failure" } },
        ]);

        // An unsafe parent blocks it with the parent's own cause.
        yield* fileSystem.remove(path.join(mount.root, ".tack"), { recursive: true });
        yield* fileSystem.symlink(other, path.join(mount.root, ".tack"));
        yield* fileSystem.makeDirectory(path.join(other, "docs", registrationId), {
          recursive: true,
        });
        const theirs = path.join(other, "docs", registrationId, "handbook");
        yield* fileSystem.symlink(
          docsRelativeTarget({
            destinationPath: theirs,
            sourceDirectoryPath: mount.sourceDirectoryPath,
          }),
          theirs,
        );
        expect(yield* removeAll(ledger())).toMatchObject([
          { _tag: "blocked", code: "docs-parent-not-directory" },
        ]);

        // A destination an earlier apply left prepared is not touched.
        const prepared = makeLinkLedger([{ _tag: "remove", link: docsLink(mount) }]);
        expect(yield* removeAll(prepared)).toMatchObject([
          { _tag: "skipped", reason: "recovery-pending" },
        ]);
      }),
    ),
  );
});
