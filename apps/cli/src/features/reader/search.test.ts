import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { profileFixture } from "../../../test/support/profile-fixture.ts";
import { searchReader } from "./search.ts";

it.layer(LiveTestLayer)("reader search", (test) => {
  test.effect("a project with no attached docs is never complete and says what to set up", () =>
    Effect.gen(function* () {
      const f = yield* profileFixture;
      const found = yield* f.run(
        searchReader(f.options, { projectName: "ci", cwd: f.project, query: "anything" }),
      );
      expect(found.complete).toBe(false);
      expect(found.setup).toEqual({
        code: "no-docs-attached",
        message:
          "Project ci has no attached docs and no registered source declares a docs resource. Add a source that declares docs in its tack.yaml, then attach one.",
        next: "tack source add <path-to-a-source-that-declares-docs>",
      });
      expect(found.total).toBe(0);
      expect(found.hits).toEqual([]);
    }),
  );
});
