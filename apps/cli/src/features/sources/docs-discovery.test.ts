import { resolveCatalog } from "../../../test/support/snapshot-helpers.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { initializeState, readState } from "../../services/state-store.ts";
import { resolveCatalogFromInspections } from "./catalog.ts";
import { inspectSourcesFromState, registerSource } from "./source.ts";

const withSources = <A, E, R>(
  use: (fixture: {
    source: string;
    other: string;
    options: { environment: { TACK_STATE_DIR: string }; homeDirectory: string };
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "tack-docs-discovery-" }),
    );
    const options = {
      environment: { TACK_STATE_DIR: path.join(root, "state") },
      homeDirectory: root,
    };
    yield* initializeState(options);
    const source = path.join(root, "source");
    const other = path.join(root, "other");
    for (const directory of [source, other]) {
      yield* fs.makeDirectory(path.join(directory, "notes"), { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "tack.yaml"),
        "version: 1\ndocs:\n  - name: handbook\n    path: notes\n",
      );
      yield* registerSource(options, { sourcePath: directory });
    }
    return yield* use({ source, other, options });
  });

it.layer(LiveTestLayer)("docs declaration discovery", (test) => {
  test.effect("reads each source declaration once per catalog build", () =>
    withSources(({ source, other, options }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const reads = new Map<string, number>();
        const counting = {
          ...fs,
          readFileString: (target: string, encoding?: string) => {
            if (path.basename(target) === "tack.yaml")
              reads.set(target, (reads.get(target) ?? 0) + 1);
            return fs.readFileString(target, encoding);
          },
        };

        const catalog = yield* provideTestFileSystem(resolveCatalog(options), counting);

        expect(catalog.entries.filter((entry) => entry.address.kind === "docs")).toHaveLength(2);
        expect(Object.fromEntries(reads)).toEqual({
          [path.join(other, "tack.yaml")]: 1,
          [path.join(source, "tack.yaml")]: 1,
        });
      }),
    ),
  );

  test.effect("discovers docs from the declaration a source inspection validated", () =>
    withSources(({ source, other, options }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const inspections = yield* inspectSourcesFromState(yield* readState(options));
        yield* fs.writeFileString(path.join(source, "tack.yaml"), "version: 1\n");

        const snapshot = yield* resolveCatalogFromInspections(inspections);
        const fresh = yield* resolveCatalog(options);

        expect(
          snapshot.entries
            .filter((entry) => entry.address.kind === "docs")
            .map((entry) => entry.sourcePath),
        ).toEqual([other, source]);
        expect(snapshot.quarantined).toEqual([]);
        expect(
          fresh.entries
            .filter((entry) => entry.address.kind === "docs")
            .map((entry) => entry.sourcePath),
        ).toEqual([other]);
      }),
    ),
  );

  test.effect("reports a missing or unreadable declaration through source health", () =>
    withSources(({ source, other, options }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const declarationPath = path.join(source, "tack.yaml");
        const blocked = {
          ...fs,
          readFileString: (target: string, encoding?: string) =>
            target === declarationPath
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readFileString",
                    pathOrDescriptor: target,
                  }),
                )
              : fs.readFileString(target, encoding),
        };

        const unreadable = yield* provideTestFileSystem(resolveCatalog(options), blocked);
        yield* fs.remove(declarationPath);
        const missing = yield* resolveCatalog(options);

        for (const [catalog, code] of [
          [unreadable, "declaration-access-failed"],
          [missing, "declaration-missing"],
        ] as const) {
          expect(catalog.quarantined).toEqual([]);
          expect(catalog.unhealthySources).toMatchObject([
            { issue: { code }, registration: { canonicalPath: source }, status: "unhealthy" },
          ]);
          expect(catalog.entries.filter((entry) => entry.address.kind === "docs")).toMatchObject([
            { sourcePath: other, address: { name: "handbook" } },
          ]);
        }
      }),
    ),
  );
});
