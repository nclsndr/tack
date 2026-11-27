import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { renderHuman } from "../human/render.ts";
import { makeStyle } from "../human/style.ts";
import { createPublicEnvelope, type PublicOutcome } from "../envelope/public-outcome.ts";
import { routeOutcome } from "./route.test-support.ts";
import { typesRoutes } from "./types.ts";

const style = makeStyle({ color: false, width: 100, homeDirectory: "/nowhere" });
const options = { homeDirectory: "/nowhere" };

it.layer(LiveTestLayer)("types route", (test) => {
  const scene = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-types-" }));
    yield* fs.writeFileString(path.join(root, "tack.yaml"), "version: 1\n");
    const types = (apply: boolean, at = root) =>
      routeOutcome(typesRoutes.types.run({ _tag: "types", path: at, apply }, options));
    const render = (outcome: PublicOutcome) =>
      renderHuman(createPublicEnvelope("types", outcome), style);
    return { fs, path, root, types, render };
  });

  test.effect("previews the files with the apply command, then reports what it wrote", () =>
    Effect.gen(function* () {
      const { root, types, render } = yield* scene;
      const preview = yield* types(false);
      expect(preview).toMatchObject({ classification: "success", diagnostics: [] });
      expect(render(preview)).toContain(
        [
          "Plan",
          `  create  ${root}/tack-env.d.ts`,
          `  create  ${root}/tsconfig.json`,
          "",
          "Next",
          `  tack types ${root} --apply`,
        ].join("\n"),
      );

      const applied = yield* types(true);
      expect(applied).toMatchObject({ classification: "success", applied: { directory: root } });
      expect(render(applied)).toContain(`Files\n  created  ${root}/tack-env.d.ts`);
      expect(render(yield* types(false))).not.toContain("Next");
    }),
  );

  test.effect("warns when the source's own tsconfig.json may leave the stub out", () =>
    Effect.gen(function* () {
      const { fs, path, root, types } = yield* scene;
      const tsconfig = path.join(root, "tsconfig.json");
      yield* fs.writeFileString(tsconfig, '{"include": ["scripts/**/*.ts"]}');
      expect(yield* types(true)).toMatchObject({
        classification: "partial",
        diagnostics: [
          {
            code: "types-stub-out-of-scope",
            message: expect.stringContaining('Add "tack-env.d.ts" to its "include" list'),
            details: { path: tsconfig },
          },
        ],
      });
      yield* fs.writeFileString(tsconfig, "{ // comments\n}");
      expect(yield* types(false)).toMatchObject({
        classification: "partial",
        diagnostics: [{ message: expect.stringContaining("could not read tsconfig.json") }],
      });
    }),
  );

  test.effect("refuses a folder that is not a source", () =>
    Effect.gen(function* () {
      const { path, root, types, render } = yield* scene;
      const outcome = yield* types(true, path.join(root, "missing"));
      expect(outcome).toMatchObject({
        classification: "invalid-configuration",
        diagnostics: [{ code: "types-not-a-source" }],
      });
      expect(render(outcome).split(/\s+/).join(" ")).toContain("has no tack.yaml");
    }),
  );
});
