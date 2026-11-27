import { skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { registerSource } from "../../features/sources/source.ts";
import { initializeState, readState } from "../../services/state-store.ts";
import { envelopeOf } from "./human.test-support.ts";
import { loadReferenceIndex } from "./reference-index.ts";
import { TerminalContext, TerminalContextLive } from "./terminal-context.ts";
import { stateOptionsAt } from "../../../test/support/state-fixture.ts";

const naming = (sourceRegistrationId: string) =>
  envelopeOf({
    command: "catalog",
    result: { kind: "x", address: { kind: "skill", name: "review", sourceRegistrationId } },
  });

it.effect("the live terminal context reports this process's terminal facts", () =>
  Effect.gen(function* () {
    const context = yield* TerminalContext;
    expect(context).toEqual({
      columns: process.stdout.columns ?? 80,
      environment: process.env,
      stdinIsTerminal: process.stdin.isTTY === true,
      stdoutIsTerminal: process.stdout.isTTY === true,
    });
  }).pipe(Effect.provide(TerminalContextLive)),
);

it.layer(LiveTestLayer)("reference index", (test) => {
  test.effect("reads the labels of the registered sources an envelope names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-refs-" }));
      const source = path.join(root, "source");
      yield* fs.makeDirectory(path.join(source, "skills", "review"), { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "tack.yaml"),
        "version: 2\nname: tools\nskills: [{path: skills}]\n",
      );
      yield* fs.writeFileString(
        path.join(source, "skills", "review", "SKILL.md"),
        skillText("review", { description: "Review", body: "" }),
      );
      const options = stateOptionsAt(path.join(root, "state"), root);
      yield* initializeState(options);
      yield* registerSource(options, { sourcePath: source });
      const registration = (yield* readState(options)).data.sources[0];
      if (registration === undefined) throw new Error("The source did not register.");
      const index = yield* loadReferenceIndex(naming(registration.id), options);
      expect(index?.entries).toContainEqual(
        expect.objectContaining({ sourceRegistrationId: registration.id }),
      );
      expect(index?.sources).toContainEqual(
        expect.objectContaining({
          registration: expect.objectContaining({ id: registration.id }),
          label: "tools",
        }),
      );
    }),
  );

  test.effect(
    "names an unhealthy source by its directory unless another source carries that name",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "tack-refs-" }),
        );
        const options = stateOptionsAt(path.join(root, "state"), root);
        yield* initializeState(options);
        const directories = ["tools", "helpers", path.join("broken", "tools")];
        for (const directory of directories) {
          yield* fs.makeDirectory(path.join(root, directory), { recursive: true });
          yield* fs.writeFileString(
            path.join(root, directory, "tack.yaml"),
            "version: 1\nname: tools\nskills: []\n",
          );
          yield* registerSource(options, { sourcePath: path.join(root, directory) });
        }
        // An unknown key makes both declarations unreadable after registration.
        for (const directory of directories.slice(1))
          yield* fs.writeFileString(
            path.join(root, directory, "tack.yaml"),
            "version: 1\nskillz: []\n",
          );
        const ids = new Map(
          (yield* readState(options)).data.sources.map((source) => [
            source.canonicalPath,
            source.id,
          ]),
        );
        const idOf = (directory: string) => ids.get(path.join(root, directory)) ?? "";
        const index = yield* loadReferenceIndex(naming(idOf("helpers")), options);
        const labelOf = (directory: string) =>
          index?.sources?.find((source) => source.registration.id === idOf(directory));
        expect(labelOf("tools")).toMatchObject({ label: "tools", labelOrigin: "declared" });
        expect(labelOf("helpers")).toMatchObject({ label: "helpers", labelOrigin: "derived" });
        expect(labelOf(path.join("broken", "tools"))?.label).toBeUndefined();
      }),
  );

  test.effect("leaves registration IDs in place when the state cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-refs-" }));
      const notADirectory = path.join(root, "state");
      yield* fs.writeFileString(notADirectory, "not a state directory\n");
      const index = yield* loadReferenceIndex(
        naming("00000000-0000-4000-8000-000000000001"),
        stateOptionsAt(notADirectory, root),
      );
      expect(index).toBeUndefined();
    }),
  );
});
