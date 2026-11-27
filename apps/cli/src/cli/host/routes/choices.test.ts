import { skillText } from "../../../../test/support/source-tree.ts";
import { writeUnder } from "../../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../../test/support/live-test-layer.ts";
import { initializeState, readState, type StateOptions } from "../../../services/state-store.ts";
import { registerSource } from "../../../features/sources/source.ts";
import { ResourceReferenceError } from "../../../features/sources/resource-reference.ts";
import { choiceRoutes } from "./choices.ts";
import { routeOutcome } from "./route.test-support.ts";

/** Two sources: `tools` with a skill and a command named review, `more` with a skill review. */
const scene = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "tack-pick-route-" }),
  );
  const write = writeUnder(root);
  yield* write(
    "tools/tack.yaml",
    "version: 2\nname: tools\nskills: [{path: skills}]\ncommands: [{path: review.md}]\n",
  );
  yield* write("tools/review.md", "Review the change");
  yield* write(
    "tools/skills/review/SKILL.md",
    skillText("review", { description: "Review", body: "" }),
  );
  yield* write("more/tack.yaml", "version: 2\nname: more\nskills: [{path: skills}]\n");
  yield* write(
    "more/skills/review/SKILL.md",
    skillText("review", { description: "Review", body: "" }),
  );
  const options = {
    stateDirectory: path.join(root, "state"),
    homeDirectory: path.join(root, "home"),
  } satisfies StateOptions;
  yield* initializeState(options);
  yield* registerSource(options, { sourcePath: path.join(root, "tools") });
  yield* registerSource(options, { sourcePath: path.join(root, "more") });
  return { options };
});

const user = { _tag: "user" } as const;

const userPicks = (options: StateOptions) =>
  readState(options).pipe(
    Effect.map((state) =>
      (state.data.userChoices ?? []).map(
        ({ address, decision }) => `${decision} ${address.kind} ${address.name}`,
      ),
    ),
  );

it.layer(LiveTestLayer)("pick routes", (test) => {
  test.effect("includes and excludes the resource of the requested kind", () =>
    Effect.gen(function* () {
      const { options } = yield* scene;
      expect(
        yield* routeOutcome(
          choiceRoutes["choice-set"].run(
            { _tag: "choice-set", reference: "tools:review", kind: "command", namespace: user },
            options,
          ),
        ),
      ).toMatchObject({ classification: "success" });
      expect(
        yield* routeOutcome(
          choiceRoutes["choice-exclude"].run(
            { _tag: "choice-exclude", reference: "more:review", kind: "skill", namespace: user },
            options,
          ),
        ),
      ).toMatchObject({ classification: "success" });
      expect((yield* userPicks(options)).toSorted()).toEqual([
        "exclude skill review",
        "include command review",
      ]);
    }),
  );

  test.effect("names one remove command per stored pick an unqualified name matches", () =>
    Effect.gen(function* () {
      const { options } = yield* scene;
      for (const [reference, kind] of [
        ["tools:review", "command"],
        ["more:review", "skill"],
      ] as const)
        yield* routeOutcome(
          choiceRoutes["choice-set"].run(
            { _tag: "choice-set", reference, kind, namespace: user },
            options,
          ),
        );
      const remove = choiceRoutes["choice-remove"];
      const error = yield* routeOutcome(
        remove.run({ _tag: "choice-remove", reference: "review", namespace: user }, options),
      ).pipe(Effect.flip);
      const candidates = [
        "tack pick remove tools:review --kind command --user",
        "tack pick remove more:review --kind skill --user",
      ];
      // Stored picks keep registration order, and registration IDs are random.
      if (error instanceof ResourceReferenceError === false) throw error;
      expect(error.code).toBe("resource-ambiguous");
      expect(error.candidates.toSorted()).toEqual(candidates.toSorted());
      expect(error.message).toBe(
        `review matches several picks. Use ${error.candidates.join(" or ")}.`,
      );
      expect((yield* userPicks(options)).length).toBe(2);

      expect(
        yield* routeOutcome(
          remove.run(
            { _tag: "choice-remove", reference: "review", kind: "command", namespace: user },
            options,
          ),
        ),
      ).toMatchObject({ classification: "success" });
      expect(yield* userPicks(options)).toEqual(["include skill review"]);
    }),
  );

  test.effect("reports a removal that matches neither a stored pick nor the catalog", () =>
    Effect.gen(function* () {
      const { options } = yield* scene;
      const error = yield* routeOutcome(
        choiceRoutes["choice-remove"].run(
          { _tag: "choice-remove", reference: "unknown", namespace: user },
          options,
        ),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ResourceReferenceError",
        code: "resource-not-found",
        candidates: [],
        message: "No stored pick matches unknown. Run tack pick to list picks.",
      });
    }),
  );
});
