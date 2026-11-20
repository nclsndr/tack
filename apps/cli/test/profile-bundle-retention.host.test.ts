import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runBundleApply } from "../src/features/profiles/bundle-apply.ts";
import { readState } from "../src/services/state-store.ts";
import { bundleFixture } from "./support/bundle-fixture.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";

it.layer(LiveTestLayer)("bundle payload retention", (test) => {
  test.effect("a linked payload parent in the state directory refuses the apply", () =>
    Effect.gen(function* () {
      const { fs, path, root, options, request, run, file } = yield* bundleFixture;
      const elsewhere = path.join(root, "elsewhere");
      yield* fs.makeDirectory(elsewhere);
      const bundles = path.join(options.environment.TACK_STATE_DIR, "bundles");
      yield* fs.symlink(elsewhere, bundles);
      const before = yield* readState(options);
      const result = yield* run(runBundleApply(options, { ...request, file, force: true }));
      expect(result.plan.refused).toBe(true);
      expect(result.plan.findings[0]).toMatchObject({
        code: "profile-bundle-identity",
        message: expect.stringContaining(`Unsafe retained payload parent ${bundles}.`),
      });
      expect(yield* readState(options)).toEqual(before);
      expect(yield* fs.readDirectory(elsewhere)).toEqual([]);
    }),
  );

  test.effect("an extra entry in a retained payload refuses its reuse", () =>
    Effect.gen(function* () {
      const { fs, path, options, request, run, file, archive } = yield* bundleFixture;
      expect((yield* run(runBundleApply(options, { ...request, file }))).plan.refused).toBe(false);
      const payload = path.join(
        options.environment.TACK_STATE_DIR,
        "bundles",
        archive.manifest.identity,
      );
      yield* fs.writeFileString(path.join(payload, "extra"), "foreign");
      const applied = yield* readState(options);
      const reused = yield* run(runBundleApply(options, { ...request, file, force: true }));
      expect(reused.plan.findings[0]).toMatchObject({
        code: "profile-bundle-identity",
        message: `Foreign/changed retained payload inventory at ${payload}. Repair it before reuse.`,
      });
      expect(yield* readState(options)).toEqual(applied);
    }),
  );
});
