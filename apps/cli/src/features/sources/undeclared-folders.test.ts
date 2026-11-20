import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { kindFoldersAt, undeclaredFoldersMessage } from "./undeclared-folders.ts";

it.layer(BunServices.layer)("undeclared kind folders", (test) => {
  test.effect("lists only the kind folders that are directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tack-undeclared-" });
      yield* fs.makeDirectory(path.join(root, "skills"));
      yield* fs.makeDirectory(path.join(root, "scripts"));
      yield* fs.writeFileString(path.join(root, "context"), "a file named like a kind folder\n");
      expect(yield* kindFoldersAt(root)).toEqual(["skills", "scripts"]);
    }),
  );
});

it("names each folder with the entry that declares it and a placeholder script entry", () => {
  expect(undeclaredFoldersMessage(["skills", "scripts"])).toBe(
    "Tack reads resources only from declarations, and this tack.yaml declares none. Found `skills/`, `scripts/`. Add `skills: [{ path: skills }]`, `scripts: [{ name: <name>, path: scripts/<file>.ts, description: <text> }]`. If a folder is ordinary content, declare it empty instead, such as `skills: []`.",
  );
  expect(undeclaredFoldersMessage([])).toContain("such as `skills: []`.");
});
