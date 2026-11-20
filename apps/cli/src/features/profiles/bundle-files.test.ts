import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { execFileSync } from "node:child_process";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { bundleLimits } from "../../domain/bundles/tar.ts";
import { makeBundleFileCollector, type BundleBudget } from "./bundle-files.ts";
import { readBundleArchive } from "./bundle-read.ts";
import type { ProfilePlanFinding } from "../../domain/profiles/profile-schema.ts";

const prefix = "sources/source-0/";

/** A scratch source root and a collector over it with a fresh or given budget. */
const withCollector = <A, E, R>(
  use: (context: {
    readonly root: string;
    readonly findings: ProfilePlanFinding[];
    readonly budget: BundleBudget;
    readonly collector: Effect.Success<ReturnType<typeof makeBundleFileCollector>>;
  }) => Effect.Effect<A, E, R>,
  budget: BundleBudget = { bytes: 0, entries: 0, exhausted: false },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-bundle-" }));
    const findings: ProfilePlanFinding[] = [];
    const collector = yield* makeBundleFileCollector(root, prefix, findings, budget);
    return yield* use({ root, findings, budget, collector });
  }).pipe(Effect.scoped);

const fileEntry = (text: string) =>
  ({
    path: `${prefix}notes.md`,
    kind: "file",
    mode: 0o644,
    bytes: new TextEncoder().encode(text),
  }) as const;

it.layer(LiveTestLayer)("bundle file collector", (test) => {
  test.effect("an entry whose bytes change between two reads is reported", () =>
    withCollector(({ findings, collector }) =>
      Effect.sync(() => {
        collector.add(fileEntry("one"));
        collector.add(fileEntry("one"));
        expect(findings).toEqual([]);
        collector.add(fileEntry("two"));
        expect(findings).toEqual([
          {
            code: "profile-bundle-incomplete",
            message: `${prefix}notes.md changed while reading; retry from stable content.`,
          },
        ]);
      }),
    ),
  );

  test.effect("the entry budget stops the walk once and keeps it stopped", () =>
    withCollector(
      ({ root, findings, budget, collector }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${root}/a.md`, "a");
          yield* fs.writeFileString(`${root}/b.md`, "b");
          yield* collector.include("a.md");
          expect(budget.exhausted).toBe(true);
          yield* collector.include("b.md");
          collector.add(fileEntry("late"));
          expect(collector.entries.size).toBe(0);
          expect(findings.map((finding) => finding.code)).toEqual(["profile-bundle-limit"]);
        }),
      { bytes: 0, entries: bundleLimits.entries, exhausted: false },
    ),
  );

  test.effect("a special file, a missing path and an unsafe path are findings, not content", () =>
    withCollector(({ root, findings, collector }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${root}/skill`);
        execFileSync("mkfifo", [`${root}/skill/pipe`]);
        yield* collector.include("skill/pipe");
        yield* collector.include("skill/missing.md");
        yield* collector.include("../outside.md");
        expect(findings.map((finding) => finding.code)).toEqual([
          "profile-bundle-incomplete",
          "profile-bundle-incomplete",
          "profile-bundle-invalid",
        ]);
        expect(findings[0]?.message).toBe(
          "skill/pipe is not a regular file/directory. Materialize its content first.",
        );
        expect(findings[1]?.message).toMatch(
          /^Required content skill\/missing\.md is unavailable: .+\. Declare\/materialize missing support before export\.$/,
        );
        expect([...collector.entries.keys()]).toEqual([`${prefix}skill`]);
      }),
    ),
  );

  test.effect("a declared path through a symlink is reported once per linked segment", () =>
    withCollector(({ root, findings, collector }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(`${root}/real`);
        yield* fs.symlink(path.join(root, "real"), path.join(root, "linked"));
        yield* collector.checkDeclaredPath("real");
        expect(findings).toEqual([]);
        yield* collector.checkDeclaredPath("linked/context.md");
        expect(findings).toEqual([
          {
            code: "profile-bundle-incomplete",
            message:
              "linked/context.md is a source symlink. Materialize it explicitly before export.",
          },
        ]);
      }),
    ),
  );

  test.effect("an artifact over the compressed limit is refused before it is read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tack-bundle-" });
      const file = `${root}/large.tar.gz`;
      yield* fs.writeFileString(file, "");
      yield* fs.truncate(file, bundleLimits.compressedBytes + 1);
      const error = yield* readBundleArchive(file).pipe(Effect.flip);
      expect(error).toMatchObject({
        code: "profile-bundle-limit",
        message: "Bundle exceeds the compressed input limit.",
      });
    }).pipe(Effect.scoped),
  );
});
