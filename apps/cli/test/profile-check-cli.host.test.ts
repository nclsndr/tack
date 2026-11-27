import { fakeGit } from "./support/fake-git.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { exitCodeForEnvelope } from "../src/cli/envelope/public-outcome.ts";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

it.layer(LiveTestLayer)("profile files through check CLI", (test) => {
  test.effect(
    "prints file locations, error exit status and the same in-process inventory without any state write",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "profile-cli-" }),
        );
        yield* fs.writeFileString(
          path.join(root, "tack.yaml"),
          "version: 1\nname: tools\ncommands:\n  - path: run.md\nprofiles:\n  - name: ci\n    path: ci.yaml\n",
        );
        yield* fs.writeFileString(path.join(root, "run.md"), "Run");
        yield* fs.writeFileString(
          path.join(root, "ci.yaml"),
          "version: 1\nname: ci\nmembers: [run]\n",
        );
        const state = path.join(root, "state");
        const run = (args: ReadonlyArray<string>) =>
          runHost({
            args: ["--state-dir", state, ...args],
            git: fakeGit(root, []),
          }).pipe(Effect.map((result) => result.stdout));
        const command = ["check", path.join(root, "ci.yaml")];
        const text = yield* run(command);
        expect(text).toContain("Structure: valid · Source linkage: complete");
        expect(text).toContain("Direct members (1)");
        const valid = decodeEnvelope(yield* run(["--json", ...command]));
        expect(exitCodeForEnvelope(valid)).toBe(0);
        expect(valid.result).toMatchObject({ kind: "check-report", summary: { errors: 0 } });
        yield* fs.writeFileString(
          path.join(root, "ci.yaml"),
          "version: 1\nname: ci\nmembers: [missing]\n",
        );
        const invalidText = yield* run(command);
        expect(invalidText).toContain(
          `${path.join(root, "ci.yaml")}:3: error profile-member-missing:`,
        );
        const invalid = decodeEnvelope(yield* run(["--json", ...command]));
        expect(exitCodeForEnvelope(invalid)).toBe(1);
        expect(invalid.result).toMatchObject({
          findings: [expect.objectContaining({ code: "profile-member-missing" })],
        });
        expect(yield* fs.exists(state)).toBe(false);
      }),
  );
});
