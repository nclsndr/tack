import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

/**
 * The file-system behaviour Tack relies on, as one suite every `FileSystem` implementation must
 * pass: Node's in the CLI tests and the in-memory one the website's browser build uses. Each case
 * works inside a fresh scoped temporary directory, so it never touches anything else.
 */
export const fileSystemContract = (
  name: string,
  layer: Layer.Layer<FileSystem.FileSystem | Path.Path>,
) =>
  describe(`${name} file system contract`, () => {
    /** Runs `body` with the services and a canonical, empty temporary directory. */
    const withRoot = <A, E>(
      body: (
        root: string,
        fs: FileSystem.FileSystem,
        path: Path.Path,
      ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "tack-fs-contract-" }),
          );
          return yield* body(root, fs, path);
        }),
      ).pipe(Effect.provide(layer));

    const reason = <A>(effect: Effect.Effect<A, { readonly reason: { readonly _tag: string } }>) =>
      Effect.match(effect, { onFailure: (error) => error.reason._tag, onSuccess: () => "success" });

    it.effect("creates nested directories, writes, reads and lists files", () =>
      withRoot((root, fs) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(`${root}/skills/review`, { recursive: true });
          yield* fs.makeDirectory(`${root}/skills/review`, { recursive: true });
          yield* fs.writeFileString(`${root}/skills/review/SKILL.md`, "# Review");
          yield* fs.writeFileString(`${root}/skills/b.md`, "b");

          expect(yield* fs.readFileString(`${root}/skills/review/SKILL.md`)).toBe("# Review");
          expect((yield* fs.readDirectory(`${root}/skills`)).toSorted()).toEqual([
            "b.md",
            "review",
          ]);
          expect((yield* fs.stat(`${root}/skills`)).type).toBe("Directory");
          expect((yield* fs.stat(`${root}/skills/b.md`)).type).toBe("File");
        }),
      ),
    );

    it.effect("reports missing entries, occupied names and wrong entry types by reason", () =>
      withRoot((root, fs) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(`${root}/file`, "");
          yield* fs.makeDirectory(`${root}/full/child`, { recursive: true });

          expect(yield* reason(fs.readFile(`${root}/missing`))).toBe("NotFound");
          expect(yield* reason(fs.stat(`${root}/missing`))).toBe("NotFound");
          expect(yield* reason(fs.makeDirectory(`${root}/file`))).toBe("AlreadyExists");
          expect(yield* reason(fs.writeFileString(`${root}/file`, "", { flag: "wx" }))).toBe(
            "AlreadyExists",
          );
          expect(yield* reason(fs.readDirectory(`${root}/file/child`))).toBe("BadResource");
          expect(yield* reason(fs.remove(`${root}/full`))).not.toBe("success");
          expect(yield* fs.exists(`${root}/missing`)).toBe(false);
        }),
      ),
    );

    it.effect("resolves a relative link from the real directory that holds it", () =>
      withRoot((root, fs, path) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(`${root}/skills/review`, { recursive: true });
          yield* fs.writeFileString(`${root}/skills/review/SKILL.md`, "review");
          yield* fs.makeDirectory(`${root}/dotfiles/claude/skills`, { recursive: true });
          yield* fs.symlink(`${root}/dotfiles/claude`, `${root}/.claude`);
          const link = `${root}/.claude/skills/review`;
          // From the real directory, `dotfiles/claude/skills`, three levels up is the root.
          yield* fs.symlink("../../../skills/review", link);

          expect(yield* fs.readLink(link)).toBe("../../../skills/review");
          expect(yield* fs.realPath(link)).toBe(`${root}/skills/review`);
          expect(yield* fs.readFileString(path.join(link, "SKILL.md"))).toBe("review");
          expect((yield* fs.stat(link)).type).toBe("Directory");
          expect(yield* fs.realPath(`${root}/.claude/skills/..`)).toBe(`${root}/dotfiles/claude`);
        }),
      ),
    );

    it.effect(
      "keeps a dangling link readable but absent, and refuses to read a plain file as one",
      () =>
        withRoot((root, fs) =>
          Effect.gen(function* () {
            yield* fs.symlink(`${root}/nowhere`, `${root}/dangling`);
            yield* fs.writeFileString(`${root}/file`, "");

            expect(yield* fs.readLink(`${root}/dangling`)).toBe(`${root}/nowhere`);
            expect(yield* reason(fs.stat(`${root}/dangling`))).toBe("NotFound");
            expect(yield* fs.exists(`${root}/dangling`)).toBe(false);
            const plain = yield* reason(fs.readLink(`${root}/file`));
            expect([plain === "success", plain === "NotFound"]).toEqual([false, false]);
            expect(yield* reason(fs.readLink(`${root}/missing`))).toBe("NotFound");
          }),
        ),
    );

    it.effect("fails on a link cycle without reporting it missing", () =>
      withRoot((root, fs) =>
        Effect.gen(function* () {
          yield* fs.symlink(`${root}/b`, `${root}/a`);
          yield* fs.symlink(`${root}/a`, `${root}/b`);

          expect(yield* reason(fs.stat(`${root}/a`))).toBe("BadResource");
          expect(yield* reason(fs.realPath(`${root}/a`))).toBe("BadResource");
        }),
      ),
    );

    it.effect("removes a link without its target, and a tree only when asked", () =>
      withRoot((root, fs) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(`${root}/real/child`, { recursive: true });
          yield* fs.symlink(`${root}/real`, `${root}/link`);
          yield* fs.remove(`${root}/link`);
          yield* fs.remove(`${root}/missing`, { force: true });

          expect(yield* fs.exists(`${root}/real/child`)).toBe(true);
          expect(yield* fs.exists(`${root}/link`)).toBe(false);
          yield* fs.remove(`${root}/real`, { recursive: true });
          expect(yield* fs.readDirectory(root)).toEqual([]);
        }),
      ),
    );

    it.effect(
      "publishes a record the way the state lock does: exclusive write, then hard link",
      () =>
        withRoot((root, fs) =>
          Effect.gen(function* () {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const file = yield* fs.open(`${root}/staging`, { flag: "wx", mode: 0o600 });
                yield* file.writeAll(new TextEncoder().encode("1\n"));
                yield* file.sync;
              }),
            );
            yield* fs.link(`${root}/staging`, `${root}/state.lock`);
            yield* fs.remove(`${root}/staging`);

            expect(yield* fs.readFileString(`${root}/state.lock`)).toBe("1\n");
            expect((yield* fs.stat(`${root}/state.lock`)).mode & 0o777).toBe(0o600);
            expect(yield* reason(fs.link(`${root}/state.lock`, `${root}/state.lock`))).toBe(
              "AlreadyExists",
            );
          }),
        ),
    );

    it.effect("renames over an existing file, as the atomic state write does", () =>
      withRoot((root, fs) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(`${root}/state.json`, "old");
          yield* fs.writeFileString(`${root}/state.json.tmp`, "new");
          yield* fs.rename(`${root}/state.json.tmp`, `${root}/state.json`);

          expect(yield* fs.readFileString(`${root}/state.json`)).toBe("new");
          expect(yield* fs.readDirectory(root)).toEqual(["state.json"]);
        }),
      ),
    );
  });
