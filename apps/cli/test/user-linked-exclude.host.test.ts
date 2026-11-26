import { fakeGit } from "./support/fake-git.ts";
import { skillText } from "./support/source-tree.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

/**
 * A source with `user-wide`, which the user namespace links by default, and `plain`, which only
 * projects link until the user includes it, plus one registered project `workspace` and the claude
 * adapter.
 */
const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-user-linked-exclude-test-" }),
  );
  const stateDirectory = path.join(root, "state");
  const anchor = path.join(root, "anchor");
  const projectRoot = path.join(root, "project");
  const source = path.join(root, "source");
  const skills = { "user-wide": ["user-activation: default"], plain: [] };
  yield* Effect.forEach(
    [anchor, projectRoot, ...Object.keys(skills).map((name) => path.join(source, "skills", name))],
    (directory) => fileSystem.makeDirectory(directory, { recursive: true }),
  );
  yield* fileSystem.writeFileString(
    path.join(source, "tack.yaml"),
    "version: 1\nname: source\nskills:\n  - path: skills\n",
  );
  yield* Effect.forEach(Object.entries(skills), ([name, tack]) =>
    fileSystem.writeFileString(
      path.join(source, "skills", name, "SKILL.md"),
      skillText(name, tack.length === 0 ? { body: "" } : { tack, body: "" }),
    ),
  );
  const git = fakeGit(anchor, [{ path: projectRoot }]);
  const run = (flags: ReadonlyArray<string>, command: ReadonlyArray<string>) =>
    runHost({ args: [...flags, "--state-dir", stateDirectory, ...command], git }).pipe(
      Effect.map(({ stdout }) => stdout),
    );
  const tack = (command: ReadonlyArray<string>) =>
    run(["--json"], command).pipe(Effect.map(decodeEnvelope));
  /** The human view of a command, as an operator reads it. */
  const human = (command: ReadonlyArray<string>) => run([], command);
  yield* tack(["state", "init"]);
  yield* tack(["adapter", "enable", "claude"]);
  yield* tack(["source", "add", source, "--apply"]);
  yield* tack(["project", "add", "workspace", "--repository-cwd", projectRoot]);
  return { human, tack };
});

/** The commands a human view lists under its Next heading. */
const nextSection = (text: string) =>
  text
    .split("\n\n")
    .find((block) => block.startsWith("Next\n"))
    ?.split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0) ?? [];

const projectPicks = ["pick", "--project", "workspace"];

it.layer(LiveTestLayer)("a project exclude of a user-linked resource", (excludeIt) => {
  excludeIt.effect("is refused, records nothing and names the user exclude", () =>
    Effect.gen(function* () {
      const { human, tack } = yield* fixture;
      const command = ["pick", "exclude", "user-wide", "--project", "workspace"];
      const userExclude = "tack pick exclude source:user-wide --kind skill --user";

      const envelope = yield* tack(command);

      expect(envelope.classification).toBe("invalid-invocation");
      expect(envelope.diagnostics).toEqual([
        {
          code: "project-exclude-refused",
          details: {
            subject: {
              address: expect.objectContaining({ kind: "skill", name: "user-wide" }),
              projectName: "workspace",
            },
          },
          message: `Project workspace cannot hide skill user-wide: the user namespace links it, so every agent in the project would still see it. Nothing was recorded. Run \`${userExclude}\` to turn it off everywhere.`,
          severity: "error",
        },
      ]);
      expect(envelope.next).toEqual([userExclude]);
      expect(nextSection(yield* human(command))).toEqual([userExclude]);
      expect((yield* tack(projectPicks)).result).toEqual({ kind: "choices", choices: [] });
    }),
  );

  excludeIt.effect("is warned about by sync and status once the user links it later", () =>
    Effect.gen(function* () {
      const { human, tack } = yield* fixture;
      expect(
        (yield* tack(["pick", "exclude", "plain", "--project", "workspace"])).classification,
      ).toBe("success");
      yield* tack(["pick", "include", "plain", "--user"]);
      const userExclude = "tack pick exclude plain --kind skill --user";
      const warning = {
        code: "project-exclude-linked-for-user",
        details: {
          subject: {
            address: expect.objectContaining({ kind: "skill", name: "plain" }),
            projectName: "workspace",
          },
        },
        message:
          "A project exclude cannot hide a resource that the user namespace links, so every agent in the project still sees it. Exclude it for the user to turn it off everywhere.",
        severity: "warning",
      };

      for (const command of [
        ["sync", "--project", "workspace"],
        ["status", "--project", "workspace"],
      ]) {
        const envelope = yield* tack(command);
        expect(envelope.classification).toBe("partial");
        expect(envelope.diagnostics).toContainEqual(warning);
        expect(envelope.next).toContain(userExclude);
        expect(nextSection(yield* human(command))).toContain(userExclude);
      }
    }),
  );

  excludeIt.effect("is recorded silently for a resource only projects link", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;

      const picked = yield* tack(["pick", "exclude", "plain", "--project", "workspace"]);
      const synced = yield* tack(["sync", "--project", "workspace"]);

      expect(picked.classification).toBe("success");
      expect(picked.diagnostics).toEqual([]);
      expect(picked.next).toEqual(["tack sync --project workspace"]);
      expect(synced.classification).toBe("success");
      expect(synced.diagnostics).toEqual([]);
    }),
  );
});
