import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { parseInvocation } from "../src/cli/commands/index.ts";

it.effect("parses one variadic read-only checker and removes every older checker spelling", () =>
  Effect.gen(function* () {
    expect(
      (yield* parseInvocation([
        "check",
        "/source",
        "/profile.yaml",
        "/bundle.tar.gz",
        "/docs",
      ]).pipe(Effect.provide(BunServices.layer))).invocation,
    ).toEqual({ _tag: "check", paths: ["/source", "/profile.yaml", "/bundle.tar.gz", "/docs"] });
    for (const args of [
      ["source", "check", "/source"],
      ["profile", "check", "/source", "ci"],
      ["profile", "check-bundle", "/bundle.tar.gz"],
      ["docs", "check", "/docs"],
    ]) {
      expect(
        (yield* Effect.result(parseInvocation(args).pipe(Effect.provide(BunServices.layer))))[
          "_tag"
        ],
      ).toBe("Failure");
    }
  }),
);

import { LiveTestLayer } from "./support/live-test-layer.ts";
import { profileFixture } from "./support/profile-fixture.ts";
import { exitCodeForEnvelope } from "../src/cli/envelope/public-outcome.ts";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";
import { StateStore } from "../src/services/state-store.ts";
import { runBundleExport } from "../src/features/profiles/bundle-export.ts";
import { readBundleArchive } from "../src/features/profiles/bundle-read.ts";
import { encodeBundle, makeBundleManifest } from "../src/domain/bundles/bundle-codec.ts";
import { nodeGzip } from "../src/platform/compression/compression.ts";

const capture = (args: ReadonlyArray<string>) =>
  runHost({ args: ["--json", ...args] }).pipe(
    Effect.map((result) => decodeEnvelope(result.stdout)),
  );

it.layer(LiveTestLayer)("unified checker public results", (test) => {
  test.effect("uses one error status for a combined report without reading state", () =>
    Effect.gen(function* () {
      const f = yield* profileFixture;
      const store = yield* StateStore;
      const run = (args: ReadonlyArray<string>) =>
        f.run(capture(args)).pipe(
          Effect.provideService(StateStore, {
            ...store,
            read: () => Effect.die("stateless route read operator state"),
          }),
        );
      const success = yield* run(["check", f.source]);
      expect(exitCodeForEnvelope(success)).toBe(0);
      expect(success.result).toMatchObject({ kind: "check-report", summary: { errors: 0 } });
      const invalid = yield* run(["check", f.source, f.path.join(f.root, "missing")]);
      expect(exitCodeForEnvelope(invalid)).toBe(1);
      expect(invalid.result).toMatchObject({
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "check-path-unavailable", line: 1 }),
        ]),
      });
    }),
  );
  test.effect(
    "keeps bundle inspection as a read-out while check validates projected profile meaning",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        const file = f.path.join(f.root, "ci.tar.gz");
        yield* runBundleExport(f.options, { reference: "tools:ci", output: file, apply: true });
        const archive = yield* readBundleArchive(file);
        const { identity: _identity, ...content } = archive.manifest;
        const changed = makeBundleManifest({
          ...content,
          sources: content.sources.map((source) => ({
            ...source,
            resources: source.resources.map((resource) => ({ ...resource, direct: false })),
          })),
        });
        yield* f.fs.writeFile(file, encodeBundle(nodeGzip, changed, archive.entries));
        const inspected = yield* f.run(capture(["profile", "inspect-bundle", file]));
        expect(exitCodeForEnvelope(inspected)).toBe(0);
        expect(inspected.result).toMatchObject({ kind: "profile-bundle-inspection" });
        const checked = yield* f.run(capture(["check", file]));
        expect(exitCodeForEnvelope(checked)).toBe(1);
        expect(checked.result).toMatchObject({
          findings: expect.arrayContaining([
            expect.objectContaining({ code: "profile-bundle-invalid" }),
          ]),
        });
      }),
  );
});
