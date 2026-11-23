import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import type { TerminalContextShape } from "../src/cli/host/human/terminal-context.ts";
import { fakeGit } from "./support/fake-git.ts";
import { runHost } from "./support/host-runner.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { declare, skillText, write } from "./support/source-tree.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

const pipe: TerminalContextShape = {
  columns: 200,
  environment: { TERM: "dumb" },
  stdinIsTerminal: false,
  stdoutIsTerminal: false,
};

/**
 * Two clones of the repository `app`, each on its own machine with its own home and state. The
 * repository declares its own skill `review` in `.ai/skills`. `clone` runs `tack` on one machine.
 */
const clones = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-committed-links-" }),
  );
  const at = (...parts: ReadonlyArray<string>) => path.join(root, ...parts);
  const clone = Effect.fnUntraced(function* (name: string) {
    yield* fileSystem.makeDirectory(at(name, ".git"), { recursive: true });
    yield* fileSystem.makeDirectory(at(`${name}-home`), { recursive: true });
    yield* write(at(name, "tack.yaml"), declare("name: app", "skills:", "  - path: .ai/skills"));
    yield* write(at(name, ".ai", "skills", "review", "SKILL.md"), skillText("review"));
    const git = fakeGit(at(name, ".git"), [{ path: at(name) }]);
    const run = (arguments_: ReadonlyArray<string>, terminal?: TerminalContextShape) =>
      runHost({
        args: ["--state-dir", at(`${name}-state`), ...arguments_],
        git,
        env: { HOME: at(`${name}-home`) },
        ...(terminal === undefined ? {} : { terminal }),
      });
    const json = (arguments_: ReadonlyArray<string>) =>
      run(["--json", ...arguments_]).pipe(Effect.map(({ stdout }) => decodeEnvelope(stdout)));
    const text = (arguments_: ReadonlyArray<string>) =>
      run(arguments_, pipe).pipe(Effect.map(({ stdout }) => stdout));
    expect((yield* json(["state", "init"])).status).toBe("success");
    expect((yield* json(["adapter", "enable", "claude"])).status).toBe("success");
    expect((yield* json(["source", "add", at(name)])).status).toBe("success");
    expect((yield* json(["project", "add", "app", "--repository-cwd", at(name)])).status).toBe(
      "success",
    );
    return { json, text };
  });
  const first = yield* clone("first");
  expect((yield* first.json(["sync", "--project", "app", "--apply"])).status).toBe("success");
  const committed = yield* fileSystem.readLink(at("first", ".claude", "skills", "review"));
  const second = yield* clone("second");
  /** Checks a link out in the second clone, as Git does for a committed symbolic link. */
  const checkOut = (linkText: string) =>
    fileSystem
      .makeDirectory(at("second", ".claude", "skills"), { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.symlink(linkText, at("second", ".claude", "skills", "review"))),
      );
  return { at, checkOut, committed, fileSystem, second };
});

it.layer(LiveTestLayer)("links committed to a repository", (committedIt) => {
  committedIt.effect(
    "a clone adopts a committed link that is exactly the one Tack would write",
    () =>
      Effect.gen(function* () {
        const { at, checkOut, committed, fileSystem, second } = yield* clones();
        yield* checkOut(committed);
        const destinationPath = at("second", ".claude", "skills", "review");

        const preview = yield* second.json(["sync", "--project", "app"]);
        expect(preview).toMatchObject({
          status: "success",
          plan: {
            resources: {
              units: [
                {
                  adapter: "claude",
                  actions: [{ _tag: "link-adopt", destinationPath, relativeTarget: committed }],
                  conflicts: [],
                  summary: { adopt: 1, conflict: 0, create: 0 },
                },
              ],
            },
          },
        });
        const text = yield* second.text(["sync", "--project", "app"]);
        expect(text).toContain("1 to adopt");
        expect(text).toMatch(/adopt\s+\.claude\/skills\/review/);
        expect(yield* second.text(["status", "--project", "app"])).toContain("unrecorded");

        const applied = yield* second.json(["sync", "--project", "app", "--apply"]);
        expect(applied).toMatchObject({
          status: "success",
          applied: {
            resources: {
              units: [{ actions: [{ _tag: "applied", action: { _tag: "link-adopt" } }] }],
            },
          },
        });
        expect(yield* fileSystem.readLink(destinationPath)).toBe(committed);
        expect(yield* second.json(["sync", "--project", "app"])).toMatchObject({
          plan: { resources: { units: [{ actions: [], conflicts: [] }] } },
        });
        expect(yield* second.json(["status", "--project", "app"])).toMatchObject({
          status: "success",
          result: { destinations: [{ _tag: "matching", destinationPath }] },
        });

        // The adopted link is Tack's own: deselecting its skill removes it like any other.
        expect((yield* second.json(["pick", "exclude", "review", "--project", "app"])).status).toBe(
          "success",
        );
        expect(yield* second.json(["sync", "--project", "app", "--apply"])).toMatchObject({
          status: "success",
          applied: {
            resources: {
              units: [{ actions: [{ _tag: "applied", action: { _tag: "link-remove" } }] }],
            },
          },
        });
        expect(yield* fileSystem.exists(destinationPath)).toBe(false);
      }),
  );

  committedIt.effect(
    "a committed link to another target stays a conflict that names both ways out",
    () =>
      Effect.gen(function* () {
        const { at, checkOut, committed, fileSystem, second } = yield* clones();
        yield* fileSystem.makeDirectory(at("second", "elsewhere"), { recursive: true });
        yield* checkOut("../../elsewhere");
        const destinationPath = at("second", ".claude", "skills", "review");

        const preview = yield* second.json(["sync", "--project", "app"]);
        expect(preview).toMatchObject({
          status: "partial",
          plan: {
            resources: {
              units: [
                {
                  actions: [],
                  conflicts: [
                    {
                      _tag: "foreign-destination",
                      destinationPath,
                      expectedTarget: committed,
                      observation: { _tag: "relative-link", rawTarget: "../../elsewhere" },
                    },
                  ],
                },
              ],
            },
          },
        });
        const text = yield* second.text(["sync", "--project", "app"]);
        expect(text).toContain("a symbolic link to ../../elsewhere");
        expect(text).toContain(`Tack would link ${committed}`);
        expect(text).toContain("git rm");
        expect(text).toContain(".gitignore");
        expect(yield* fileSystem.readLink(destinationPath)).toBe("../../elsewhere");
      }),
  );
});
