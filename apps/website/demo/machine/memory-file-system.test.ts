import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Scope, Stream } from "effect";
import { makeMemoryFileSystem, makeMemoryPath } from "./memory-file-system.ts";
import { makeMemoryVolume } from "./memory-volume.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

const setup = (cwd = "/home/you") => {
  const volume = makeMemoryVolume();
  volume.mkdir(cwd, { recursive: true });
  const path = makeMemoryPath(cwd);
  return { volume, path, fs: makeMemoryFileSystem(volume, path) };
};

/** The reason tag of a failed effect, or `"success"`. */
const reasonOf = <A, E extends { readonly reason: { readonly _tag: string } }>(
  effect: Effect.Effect<A, E>,
) => Effect.match(effect, { onFailure: (error) => error.reason._tag, onSuccess: () => "success" });

describe("memory path", () => {
  it("resolves relative paths against its working directory", () => {
    const path = makeMemoryPath("/home/you/code/app");

    expect(path.resolve(".")).toBe("/home/you/code/app");
    expect(path.resolve("../api")).toBe("/home/you/code/api");
    expect(path.resolve("/etc", "x")).toBe("/etc/x");
    expect(path.join("a", "b")).toBe("a/b");
  });
});

describe("memory file system", () => {
  it.effect("reads and writes relative to the working directory", () =>
    Effect.gen(function* () {
      const { fs } = setup();
      yield* fs.makeDirectory("skills/review", { recursive: true });
      yield* fs.writeFileString("skills/review/SKILL.md", "# Review");
      yield* fs.symlink("skills/review", "linked");

      expect(yield* fs.readFileString("/home/you/skills/review/SKILL.md")).toBe("# Review");
      expect(yield* fs.readDirectory("skills")).toEqual(["review"]);
      expect(yield* fs.readDirectory(".", { recursive: true })).toEqual([
        "linked",
        "skills",
        "skills/review",
        "skills/review/SKILL.md",
      ]);
      expect(yield* fs.readLink("linked")).toBe("skills/review");
      expect(yield* fs.realPath("linked")).toBe("/home/you/skills/review");
      expect(yield* fs.exists("linked/SKILL.md")).toBe(true);
      expect((yield* fs.stat("linked")).type).toBe("Directory");
      expect((yield* fs.stat("skills/review/SKILL.md")).type).toBe("File");
    }),
  );

  it.effect("maps volume failures to platform error reasons", () =>
    Effect.gen(function* () {
      const { fs } = setup();
      yield* fs.writeFileString("file", "");

      expect(yield* reasonOf(fs.readFile("missing"))).toBe("NotFound");
      expect((yield* Effect.flip(fs.readFile("missing"))).message).toContain(
        "VolumeError: ENOENT: /home/you/missing",
      );
      expect(yield* reasonOf(fs.makeDirectory("file"))).toBe("AlreadyExists");
      expect(yield* reasonOf(fs.readDirectory("file"))).toBe("BadResource");
      expect(yield* reasonOf(fs.readLink("file"))).toBe("Unknown");
      expect(yield* reasonOf(fs.access("missing"))).toBe("NotFound");
      expect(yield* reasonOf(fs.access("file"))).toBe("success");
      expect(yield* reasonOf(fs.writeFileString("file", "", { flag: "wx" }))).toBe("AlreadyExists");
      expect(yield* reasonOf(fs.glob("*"))).toBe("Unknown");
      expect(yield* reasonOf(Stream.runDrain(fs.watch("file")))).toBe("Unknown");
    }),
  );

  it.effect("publishes a lock record the way the state store does: write, sync, link", () =>
    Effect.gen(function* () {
      const { fs } = setup();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open("staging", { flag: "wx", mode: 0o600 });
          yield* file.writeAll(bytes("1\n"));
          yield* file.sync;
        }),
      );
      yield* fs.link("staging", "state.lock");
      yield* fs.remove("staging", { force: true });

      expect(yield* fs.readFileString("state.lock")).toBe("1\n");
      expect((yield* fs.stat("state.lock")).mode).toBe(0o600);
      expect(yield* reasonOf(Effect.scoped(fs.open("state.lock", { flag: "wx" })))).toBe(
        "AlreadyExists",
      );
      expect(yield* reasonOf(Effect.scoped(fs.open("state.lock", { flag: "ax" })))).toBe(
        "AlreadyExists",
      );
    }),
  );

  it.effect("reads, seeks, appends and truncates through an open file", () =>
    Effect.gen(function* () {
      const { fs } = setup();
      yield* fs.writeFileString("log", "abc");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* fs.open("log");
          const buffer = new Uint8Array(2);
          expect(yield* reader.read(buffer)).toBe(2);
          expect(yield* reader.readAlloc(8)).toEqual(Option.some(bytes("c")));
          expect(yield* reader.readAlloc(8)).toEqual(Option.none());
          expect(yield* reader.read(buffer)).toBe(0);
          expect(yield* reader.seek(1n, "start")).toBe(1n);
          expect(yield* reader.seek(1n, "current")).toBe(2n);
          expect(Number((yield* reader.stat).size)).toBe(3);

          const appender = yield* fs.open("log", { flag: "a" });
          expect(yield* appender.write(bytes("de"))).toBe(2);
          yield* appender.truncate(4);
        }),
      );
      yield* fs.writeFile("log", bytes("!"), { flag: "a" });
      yield* fs.truncate("log", 2);

      expect(yield* fs.readFileString("log")).toBe("ab");
      expect(yield* fs.readFileString("log", "utf-8")).toBe("ab");
    }),
  );

  it.effect("removes scoped temporary entries when their scope closes", () =>
    Effect.gen(function* () {
      const { fs } = setup();
      const scope = yield* Scope.make();
      const directory = yield* fs
        .makeTempDirectoryScoped({ prefix: "bundle-" })
        .pipe(Scope.provide(scope));
      const file = yield* fs
        .makeTempFileScoped({ prefix: "export-", suffix: ".tackbundle" })
        .pipe(Scope.provide(scope));
      const kept = yield* fs.makeTempFile({ directory: "/home/you" });

      expect(directory).toMatch(/^\/tmp\/bundle-/);
      expect(file).toMatch(/^\/tmp\/export-.*\.tackbundle$/);
      expect(yield* fs.exists(directory)).toBe(true);
      yield* Scope.close(scope, Exit.void);
      expect(yield* fs.exists(directory)).toBe(false);
      expect(yield* fs.exists(file)).toBe(false);
      expect(yield* fs.exists(kept)).toBe(true);
    }),
  );

  it.effect(
    "copies trees and files, renames, changes modes and accepts owner and time changes",
    () =>
      Effect.gen(function* () {
        const { fs } = setup();
        yield* fs.makeDirectory("tree/inner", { recursive: true });
        yield* fs.writeFileString("tree/inner/note", "kept");
        yield* fs.symlink("inner/note", "tree/alias");
        yield* fs.copy("tree", "copy");
        yield* fs.copyFile("copy/inner/note", "single");
        yield* fs.rename("single", "renamed");
        yield* fs.chmod("renamed", 0o600);
        yield* fs.writeFileString("private", "", { mode: 0o600 });
        expect((yield* fs.stat("private")).mode).toBe(0o600);
        yield* fs.chown("renamed", 1, 1);
        yield* fs.utimes("renamed", 0, 0);

        expect(yield* fs.readFileString("copy/alias")).toBe("kept");
        expect(yield* fs.readLink("copy/alias")).toBe("inner/note");
        expect(yield* fs.readFileString("renamed")).toBe("kept");
        expect((yield* fs.stat("renamed")).mode).toBe(0o600);
        expect(yield* reasonOf(fs.copy("tree", "copy"))).toBe("AlreadyExists");
        yield* fs.copy("tree", "copy", { overwrite: true });
        yield* fs.remove("copy", { recursive: true });
        expect(yield* fs.exists("copy")).toBe(false);
      }),
  );
});
