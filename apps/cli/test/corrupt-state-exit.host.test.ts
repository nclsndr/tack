import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { hostTack, withTackWorld } from "./support/tack-world.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

it.layer(LiveTestLayer)("corrupt state", (corruptIt) => {
  corruptIt.effect("classifies corrupt persisted state with the stable persistence exit", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(fixture.stateDirectory, "state.json"),
          "{not-valid-json",
        );

        const result = yield* hostTack(fixture, ["status", "--project", "workspace"]);
        expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(3));
        expect(result.stderr).toBe("");
        expect(decodeEnvelope(result.stdout)).toMatchObject({
          classification: "persistence",
          command: "status",
          status: "failure",
        });
      }),
    ),
  );
});
