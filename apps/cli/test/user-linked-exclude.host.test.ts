import { fakeGit } from "./support/fake-git.ts";
import { skillText } from "./support/source-tree.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

/**
 * A source with `user-wide`, which the user namespace links, and `plain`, which only projects
 * link, plus one registered project `workspace` and the claude adapter.
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
  const run = (flags: ReadonlyArray<string>, arguments_: ReadonlyArray<string>) =>
    runHost({ args: [...flags, "--state-dir", stateDirectory, ...arguments_], git }).pipe(
      Effect.map(({ stdout }) => stdout),
    );
  const tack = (arguments_: ReadonlyArray<string>) =>
    run(["--json"], arguments_).pipe(Effect.map(decodeEnvelope));
  /** The human view of a command, as an operator reads it. */
  const human = (arguments_: ReadonlyArray<string>) => run([], arguments_);
  yield* tack(["state", "init"]);
  yield* tack(["adapter", "enable", "claude"]);
  yield* tack(["source", "add", source, "--apply"]);
  yield* tack(["project", "add", "workspace", "--repository-cwd", projectRoot]);
  return { human, tack };
});

const userExclude = "tack pick exclude user-wide --kind skill --user";

/** The commands a human view lists under its Next heading. */
const nextSection = (text: string) =>
  text
    .split("\n\n")
    .find((block) => block.startsWith("Next\n"))
    ?.split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0) ?? [];

it.layer(LiveTestLayer)("a project exclude of a user-linked resource", (excludeIt) => {
  excludeIt.effect("says that pick exclude cannot hide it and names the user exclude", () =>
    Effect.gen(function* () {
      const { human, tack } = yield* fixture;
      const command = ["pick", "exclude", "source:user-wide", "--project", "workspace"];

      const envelope = yield* tack(command);

      expect(envelope.classification).toBe("success");
      expect(envelope.diagnostics).toEqual([
        {
          code: "project-exclude-linked-for-user",
          details: {
            subject: {
              address: expect.objectContaining({ kind: "skill", name: "user-wide" }),
              projectName: "workspace",
            },
          },
          message:
            "Project workspace cannot hide skill user-wide: the user namespace links it, so every agent in the project still sees it. Excluding it for the user turns it off everywhere.",
          severity: "info",
        },
      ]);
      expect(envelope.next).toEqual([userExclude, "tack sync --project workspace"]);
      expect(nextSection(yield* human(command))).toEqual([
        userExclude,
        "tack sync --project workspace",
      ]);
    }),
  );

  excludeIt.effect("keeps saying it in the sync preview while the exclude is recorded", () =>
    Effect.gen(function* () {
      const { human, tack } = yield* fixture;
      yield* tack(["pick", "exclude", "source:user-wide", "--project", "workspace"]);
      const command = ["sync", "--project", "workspace"];

      const envelope = yield* tack(command);

      expect(envelope.classification).toBe("success");
      expect(envelope.diagnostics.map(({ code, severity }) => [code, severity])).toEqual([
        ["project-exclude-linked-for-user", "info"],
      ]);
      expect(envelope.next).toEqual([userExclude, "tack sync --project workspace --apply"]);
      const text = yield* human(command);
      expect(text).toContain("Project workspace cannot hide skill user-wide");
      expect(nextSection(text)).toEqual([userExclude, "tack sync --project workspace --apply"]);
    }),
  );

  excludeIt.effect("adds nothing for an exclude of a resource only projects link", () =>
    Effect.gen(function* () {
      const { tack } = yield* fixture;

      const picked = yield* tack(["pick", "exclude", "source:plain", "--project", "workspace"]);
      const synced = yield* tack(["sync", "--project", "workspace"]);

      expect(picked.diagnostics).toEqual([]);
      expect(picked.next).toEqual(["tack sync --project workspace"]);
      expect(synced.diagnostics).toEqual([]);
      // The only other skill is linked for the user, so the preview has nothing left to apply.
      expect(synced.next).toEqual([]);
    }),
  );
});
