import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import type { LinkRecord } from "../../domain/links/link-record-schema.ts";
import { emptyState } from "../../domain/state/state-schema.ts";
import { observeHandMadeEntries, observeRootHandMadeEntries } from "./hand-made-entries.ts";

it.layer(LiveTestLayer)("hand-made entries", (handMadeIt) => {
  /** A temporary home with the given folders, files and links under it. */
  const home = Effect.fnUntraced(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-hand-made-" }),
    );
    return { fileSystem, at: (...parts: ReadonlyArray<string>) => path.join(root, ...parts), root };
  });

  /** A record Tack would hold for a link it made at `destinationPath`. */
  const recorded = (destinationPath: string, root: string): LinkRecord => ({
    destinationPath,
    sourceDirectoryPath: "/sources/skills/review",
    resource: { kind: "skill", name: "review", sourceRegistrationId: "source" },
    target: { _tag: "user", canonicalPath: root },
    delivery: { _tag: "agent", adapter: "claude" },
  });

  handMadeIt.effect(
    "lists every entry Tack has no record of, by type, and leaves out its own and hidden ones",
    () =>
      Effect.gen(function* () {
        const { fileSystem, at, root } = yield* home();
        yield* fileSystem.makeDirectory(at(".claude", "skills", "my-own"), { recursive: true });
        yield* fileSystem.makeDirectory(at(".cursor", "commands"), { recursive: true });
        yield* fileSystem.makeDirectory(at("elsewhere"), { recursive: true });
        yield* fileSystem.writeFileString(at(".claude", "skills", "notes.md"), "mine\n");
        yield* fileSystem.writeFileString(at(".claude", "skills", ".DS_Store"), "");
        yield* fileSystem.writeFileString(at(".cursor", "commands", "ship.md"), "ship\n");
        yield* fileSystem.symlink(at("elsewhere"), at(".claude", "skills", "linked"));
        yield* fileSystem.symlink("../../elsewhere", at(".claude", "skills", "relative"));
        yield* fileSystem.symlink(at("elsewhere"), at(".claude", "skills", "review"));

        const entries = yield* observeHandMadeEntries(
          [recorded(at(".claude", "skills", "review"), root)],
          { _tag: "user", canonicalPath: root },
          ["claude", "codex", "cursor"],
        );

        // Codex's folder does not exist, and Tack's own link at `review` is not hand-made.
        expect(entries).toEqual([
          {
            adapter: "claude",
            kind: "skill",
            path: at(".claude", "skills", "linked"),
            entry: "symlink",
          },
          {
            adapter: "claude",
            kind: "skill",
            path: at(".claude", "skills", "my-own"),
            entry: "directory",
          },
          {
            adapter: "claude",
            kind: "skill",
            path: at(".claude", "skills", "notes.md"),
            entry: "file",
          },
          {
            adapter: "claude",
            kind: "skill",
            path: at(".claude", "skills", "relative"),
            entry: "symlink",
          },
          {
            adapter: "cursor",
            kind: "command",
            path: at(".cursor", "commands", "ship.md"),
            entry: "file",
          },
        ]);
      }),
  );

  handMadeIt.effect("looks only in the folders of the adapters it is given", () =>
    Effect.gen(function* () {
      const { fileSystem, at, root } = yield* home();
      yield* fileSystem.makeDirectory(at(".cursor", "skills", "mine"), { recursive: true });
      expect(
        yield* observeHandMadeEntries([], { _tag: "user", canonicalPath: root }, ["claude"]),
      ).toEqual([]);
    }),
  );

  handMadeIt.effect(
    "lists the entries in the project folders of every root for the adapters the state enables",
    () =>
      Effect.gen(function* () {
        const { fileSystem, at, root } = yield* home();
        const main = at("main");
        const feature = at("feature");
        yield* fileSystem.makeDirectory(at("main", ".claude", "skills", "code-review"), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(at("main", ".agents", "skills", "codex-only"), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(at("feature", ".cursor", "commands"), { recursive: true });
        yield* fileSystem.writeFileString(
          at("feature", ".cursor", "commands", "ship.md"),
          "ship\n",
        );
        yield* fileSystem.symlink(at("elsewhere"), at("main", ".claude", "skills", "review"));
        const state = emptyState();

        const entries = yield* observeRootHandMadeEntries(
          {
            ...state,
            data: {
              ...state.data,
              enabledAdapters: ["claude", "cursor"],
              links: [
                {
                  ...recorded(at("main", ".claude", "skills", "review"), root),
                  target: { _tag: "project-root", canonicalPath: main, projectName: "app" },
                },
              ],
            },
          },
          [main, feature],
        );

        // Codex is not enabled, and Tack's own link at `review` is not hand-made.
        expect(entries).toEqual([
          {
            adapter: "cursor",
            kind: "command",
            path: at("feature", ".cursor", "commands", "ship.md"),
            entry: "file",
          },
          {
            adapter: "claude",
            kind: "skill",
            path: at("main", ".claude", "skills", "code-review"),
            entry: "directory",
          },
        ]);
      }),
  );
});
