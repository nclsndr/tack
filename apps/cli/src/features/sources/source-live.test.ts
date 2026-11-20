import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, PlatformError } from "effect";
import { Source } from "./source.ts";
import { builtInSource } from "../../release.ts";
import { SourceLive } from "./source-live.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";

const configuredSources = (fs: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    return (yield* Source).builtInSources;
  }).pipe(Effect.provide(SourceLive), Effect.provideService(FileSystem.FileSystem, fs));

it.layer(LiveTestLayer)("built-in source adapter", (sourceIt) => {
  sourceIt.effect("uses the canonical bundled directory returned by the filesystem", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sources = yield* configuredSources({
        ...fs,
        realPath: () => Effect.succeed("/verified/builtins"),
      });
      expect(sources).toEqual([{ ...builtInSource, canonicalPath: "/verified/builtins" }]);
    }),
  );

  sourceIt.effect("keeps missing bundled locations available for source health diagnostics", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sources = yield* configuredSources({
        ...fs,
        realPath: () =>
          Effect.fail(
            PlatformError.badArgument({ module: "builtin-source-test", method: "realPath" }),
          ),
      });
      expect(sources).toEqual([builtInSource]);
    }),
  );
});
