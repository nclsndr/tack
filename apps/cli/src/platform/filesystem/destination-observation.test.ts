import { spawnSync } from "node:child_process";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { makeDestinationService } from "./destination-observation.ts";

const notFound = (target: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "realPath",
    pathOrDescriptor: target,
  });

it.layer(LiveTestLayer)("destination link directories", (destinationIt) => {
  destinationIt.effect("resolves a missing directory below its nearest real ancestor", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-link-directory-test-" }),
      );
      const real = path.join(root, "dotfiles", "deeper", "cursor");
      yield* fileSystem.makeDirectory(real, { recursive: true });
      yield* fileSystem.symlink(real, path.join(root, ".cursor"));
      const destination = makeDestinationService(fileSystem, path);

      expect(yield* destination.linkDirectory(path.join(root, ".cursor", "skills", "nested"))).toBe(
        path.join(real, "skills", "nested"),
      );
      expect(yield* destination.linkDirectory(path.join(root, ".cursor"))).toBe(real);
    }),
  );

  destinationIt.effect("keeps the lexical directory when no ancestor can be resolved", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const denied = makeDestinationService(
        {
          ...fileSystem,
          realPath: (target) =>
            target === "/blocked"
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "realPath",
                    pathOrDescriptor: target,
                  }),
                )
              : Effect.fail(notFound(target)),
        },
        path,
      );
      const vanished = makeDestinationService(
        { ...fileSystem, realPath: (target) => Effect.fail(notFound(target)) },
        path,
      );

      expect(yield* denied.linkDirectory("/blocked/.cursor/skills")).toBe(
        "/blocked/.cursor/skills",
      );
      expect(yield* vanished.linkDirectory("/missing/.cursor/skills")).toBe(
        "/missing/.cursor/skills",
      );
    }),
  );

  destinationIt.effect(
    "observes relative link text from the real directory containing the link",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-link-observation-test-" }),
        );
        const source = path.join(root, "source", "guide");
        const real = path.join(root, "dotfiles", "deeper", "cursor", "skills");
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.makeDirectory(real, { recursive: true });
        yield* fileSystem.symlink(path.dirname(real), path.join(root, ".cursor"));
        const lexical = path.join(root, ".cursor", "skills");
        const resolving = path.join(lexical, "resolving");
        const lexicalOnly = path.join(lexical, "lexical-only");
        yield* fileSystem.symlink(path.relative(real, source), resolving);
        yield* fileSystem.symlink(path.relative(lexical, source), lexicalOnly);
        const destination = makeDestinationService(fileSystem, path);

        expect(yield* destination.observe(resolving)).toEqual({
          _tag: "relative-link",
          canonicalTarget: source,
          destinationPath: resolving,
          rawTarget: path.relative(real, source),
        });
        expect(yield* destination.observe(lexicalOnly)).toMatchObject({
          _tag: "unresolved-relative-link",
          destinationPath: lexicalOnly,
          rawTarget: path.relative(lexical, source),
        });
      }),
  );
  destinationIt.effect(
    "observes absent paths, files, directories, special entries and absolute links",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-entry-observation-test-" }),
        );
        const file = path.join(root, "file");
        const directory = path.join(root, "directory");
        const fifo = path.join(root, "fifo");
        const absolute = path.join(root, "absolute");
        yield* fileSystem.writeFileString(file, "");
        yield* fileSystem.makeDirectory(directory);
        expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
        yield* fileSystem.symlink(file, absolute);
        const destination = makeDestinationService(fileSystem, path);

        expect(yield* destination.observe(path.join(root, "missing"))).toEqual({
          _tag: "absent",
          destinationPath: path.join(root, "missing"),
        });
        expect(yield* destination.observe(file)).toEqual({
          _tag: "entry",
          destinationPath: file,
          entryType: "file",
        });
        expect(yield* destination.observe(directory)).toMatchObject({ entryType: "directory" });
        expect(yield* destination.observe(fifo)).toMatchObject({ entryType: "special" });
        expect(yield* destination.observe(absolute)).toEqual({
          _tag: "absolute-link",
          destinationPath: absolute,
          rawTarget: file,
        });
      }),
  );

  destinationIt.effect("reports an entry it cannot inspect, and one that vanished as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const denied = (method: string, target: string) =>
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method,
          pathOrDescriptor: target,
        });
      const observing = (statError: (target: string) => PlatformError.PlatformError) =>
        makeDestinationService(
          {
            ...fileSystem,
            readLink: (target) => Effect.fail(denied("readLink", target)),
            stat: (target) => Effect.fail(statError(target)),
          },
          path,
        );

      expect(
        yield* observing((target) => denied("stat", target)).observe("/blocked/entry"),
      ).toMatchObject({
        _tag: "access-failed",
        destinationPath: "/blocked/entry",
        operation: "stat",
      });
      expect(yield* observing(notFound).observe("/vanished/entry")).toEqual({
        _tag: "absent",
        destinationPath: "/vanished/entry",
      });
    }),
  );
});
