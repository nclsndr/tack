import { Effect } from "effect";
import { profileFixture } from "./profile-fixture.ts";
import { runBundleExport, inspectBundle } from "../../src/features/profiles/bundle-export.ts";

/** A published content artifact and its isolated source/target world. */
export const bundleFixture = Effect.gen(function* () {
  const world = yield* profileFixture;
  const file = world.path.join(world.root, "profile.tar.gz");
  const result = yield* runBundleExport(world.options, {
    reference: "tools:ci",
    output: file,
    apply: true,
  });
  if (result.exported === false) return yield* Effect.die(JSON.stringify(result.plan.findings));
  return { ...world, file, archive: yield* inspectBundle(file) };
});
