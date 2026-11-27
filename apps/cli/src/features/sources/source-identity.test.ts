import { skillText } from "../../../test/support/source-tree.ts";
import { resolveCatalogAt } from "../../../test/support/snapshot-helpers.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { initializeState, type StateOptions } from "../../services/state-store.ts";

import { registerSource } from "./source.ts";
import { stateOptionsAt } from "../../../test/support/state-fixture.ts";

it.layer(LiveTestLayer)("source resource identity", (test) => {
  test.effect(
    "keeps equal names in separate sources and does not read an undeclared private/",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "tack-source-identity-" });
        const options: StateOptions = stateOptionsAt(path.join(root, "state"), root);
        yield* initializeState(options);
        for (const label of ["team", "me"]) {
          const source = path.join(root, label);
          yield* fs.makeDirectory(path.join(source, "skills", "review"), { recursive: true });
          yield* fs.writeFileString(
            path.join(source, "tack.yaml"),
            `version: 1\nname: ${label}\nskills:\n  - path: skills\n`,
          );
          yield* fs.writeFileString(
            path.join(source, "skills", "review", "SKILL.md"),
            skillText("review", { description: "Review", body: "" }),
          );
          yield* registerSource(options, { sourcePath: source });
        }
        const team = path.join(root, "team");
        yield* fs.makeDirectory(path.join(team, "private", "skills", "secret"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(team, "private", "skills", "secret", "SKILL.md"),
          skillText("secret", { description: "Secret", body: "" }),
        );
        const catalog = yield* resolveCatalogAt(options);
        expect(catalog.entries.map((entry) => entry.address.name)).toEqual(["review", "review"]);
        expect(catalog.quarantined).toEqual([]);
      }),
  );
});
