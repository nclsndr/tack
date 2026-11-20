import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { type GitService } from "../src/services/git.ts";
import { PublicEnvelopeSchema } from "../src/cli/host/public-outcome.ts";
import { type TerminalContextShape } from "../src/cli/host/human/terminal-context.ts";
import { displayWidth } from "../src/cli/host/human/text.ts";
import { runHost } from "./support/host-runner.ts";

const decodeEnvelope = Schema.decodeUnknownSync(PublicEnvelopeSchema);

const interactive: TerminalContextShape = {
  columns: 80,
  environment: { TERM: "xterm" },
  stdinIsTerminal: true,
  stdoutIsTerminal: true,
};
// oxlint-disable-next-line no-control-regex -- The tests strip color escapes.
const plain = (text: string) => text.replace(/\u001B\[[0-9;]*m/g, "");

const pipe: TerminalContextShape = { ...interactive, stdoutIsTerminal: false };

/** A state with one registered source, one project and one delivered adapter, ready to plan. */
const prepare = Effect.fnUntraced(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: `tack-human-views-${prefix}-` }),
  );
  const state = path.join(root, "state");
  const home = path.join(root, "home");
  const project = path.join(root, "プロジェクト");
  const source = path.join(root, "source");
  yield* Effect.forEach([home, project, path.join(source, "skills", "review")], (directory) =>
    fileSystem.makeDirectory(directory, { recursive: true }),
  );
  yield* fileSystem.writeFileString(
    path.join(source, "tack.yaml"),
    "version: 1\nskills:\n  - path: skills\n",
  );
  yield* fileSystem.writeFileString(
    path.join(source, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: 変更を確認する\n---\n",
  );
  const git = {
    listWorktrees: () => Effect.succeed([{ bare: false, detached: false, path: project }]),
    resolveCommonDirectory: () => Effect.succeed(project),
  } satisfies GitService;
  const run = (arguments_: ReadonlyArray<string>, terminal: TerminalContextShape = pipe) =>
    runHost({ args: ["--state-dir", state, ...arguments_], git, terminal });
  for (const setup of [
    ["state", "init"],
    ["source", "add", source],
    ["project", "add", "demo", "--repository-cwd", project],
    ["adapter", "enable", "claude"],
    ["pick", "include", "review", "--project", "demo"],
  ])
    expect((yield* run(setup)).exit).toMatchObject({ _tag: "Success" });
  return { fileSystem, path, project, run, state };
});

it.layer(LiveTestLayer)("core human views through the CLI host", (hostIt) => {
  hostIt.effect(
    "gives every core operation a dedicated view with the exit, stderr and state of the JSON run",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, run, state } = yield* prepare("parity");
        const stateBefore = yield* fileSystem.readFileString(path.join(state, "state.json"));
        for (const [arguments_, command] of [
          [["catalog"], "catalog"],
          [["catalog", "--kind", "script"], "catalog"],
          [["--help"], "help"],
          [["status", "--help"], "help"],
          [["status", "--project", "demo"], "status"],
          [["sync", "--project", "demo"], "sync"],
          [["sync", "--project", "demo"], "sync"],
          [["status", "--project", "unknown"], "status"],
          [["sync", "--project", "unknown"], "sync"],
        ] as const) {
          const explicit = yield* run(["--json", ...arguments_], interactive);
          const automatic = yield* run(arguments_, pipe);
          expect(plain(automatic.stdout), arguments_.join(" ")).toContain(`tack ${command} ·`);
          expect(automatic.stdout).not.toBe(explicit.stdout);
          expect(decodeEnvelope(JSON.parse(explicit.stdout)).command).toBe(command);

          const human = yield* run([...arguments_], interactive);
          const label = arguments_.join(" ");
          expect(plain(human.stdout).startsWith(`tack ${command} ·`), label).toBe(true);
          expect(human.stdout, label).not.toContain('"classification"');
          expect(human.exit, label).toEqual(explicit.exit);
          expect(automatic.exit, label).toEqual(explicit.exit);
          expect(human.stderr, label).toBe(explicit.stderr);
          for (const line of human.stdout.split("\n"))
            expect(displayWidth(line), `${label}: ${line}`).toBeLessThanOrEqual(80);
        }
        // Previews and views write nothing.
        expect(yield* fileSystem.readFileString(path.join(state, "state.json"))).toBe(stateBefore);
      }),
  );

  hostIt.effect("shows what a real apply did, in the project's Japanese path", () =>
    Effect.gen(function* () {
      const { fileSystem, path, project, run } = yield* prepare("apply");
      const preview = yield* run(["sync", "--project", "demo"], interactive);
      expect(plain(preview.stdout)).toContain("Nothing was written.");
      expect(plain(preview.stdout)).toContain("tack sync --project demo --apply");
      expect(yield* fileSystem.exists(path.join(project, ".claude", "skills", "review"))).toBe(
        false,
      );
      const applied = yield* run(["sync", "--project", "demo", "--apply"], interactive);
      expect(applied.exit).toMatchObject({ _tag: "Success" });
      expect(plain(applied.stdout)).toContain("applied");
      expect(plain(applied.stdout)).toContain(".claude/skills/review");
      expect(plain(applied.stdout)).not.toContain("Next");
      expect(yield* fileSystem.exists(path.join(project, ".claude", "skills", "review"))).toBe(
        true,
      );
      const status = yield* run(["status", "--project", "demo"], interactive);
      expect(plain(status.stdout)).toContain("1 linked, 0 need attention");
      expect(plain(status.stdout)).not.toContain("Next");
    }),
  );

  hostIt.effect("keeps color out of pipes and NO_COLOR terminals", () =>
    Effect.gen(function* () {
      const { run } = yield* prepare("color");
      const args = ["catalog"];
      expect((yield* run(args, pipe)).stdout).not.toContain("\u001b[");
      expect(
        (yield* run(args, {
          ...interactive,
          environment: { FORCE_COLOR: "1", NO_COLOR: "1", TERM: "xterm" },
        })).stdout,
      ).not.toContain("\u001b[");
      expect((yield* run(args, interactive)).stdout).toContain("\u001b[");
    }),
  );
});
