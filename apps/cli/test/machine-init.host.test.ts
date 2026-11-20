import { LiveTestLayer } from "./support/live-test-layer.ts";
import { outsideRepositoryGit } from "./support/fake-git.ts";
import { runHost } from "./support/host-runner.ts";
import { decodeEnvelope } from "./support/tack-process.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import type { TerminalContextShape } from "../src/cli/host/human/terminal-context.ts";
import { InitApplicationSchema, InitPlanSchema } from "../src/domain/setup/machine-init-schema.ts";
import type { PublicEnvelope } from "../src/cli/host/public-outcome.ts";
import { Source } from "../src/features/sources/source.ts";
import { builtInSource } from "../src/release.ts";

const pipe: TerminalContextShape = {
  columns: 120,
  environment: { TERM: "dumb" },
  stdinIsTerminal: false,
  stdoutIsTerminal: false,
};

const builtIns = [
  "author-tack-profiles",
  "manage-tack-sources",
  "prepare-tack-checkout",
  "use-tack",
  "write-reader-figures",
];

const planOf = (envelope: PublicEnvelope) =>
  Schema.decodeUnknownSync(InitPlanSchema)(envelope.plan);
const appliedOf = (envelope: PublicEnvelope) =>
  Schema.decodeUnknownSync(InitApplicationSchema)(envelope.applied);

/**
 * A temporary machine whose home holds the given folders and no Tack state yet. `json` and `text`
 * run `tack` against it from its home, with an explicit state directory.
 */
const machine = Effect.fnUntraced(function* (folders: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-init-" }),
  );
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const at = (...parts: ReadonlyArray<string>) => path.join(home, ...parts);
  yield* fileSystem.makeDirectory(home, { recursive: true });
  yield* Effect.forEach(folders, (folder) =>
    fileSystem.makeDirectory(at(folder), { recursive: true }),
  );
  const source = yield* Source;
  // The release's own built-in skills, which init links, as the installed CLI does.
  const run = (arguments_: ReadonlyArray<string>, terminal?: TerminalContextShape) =>
    runHost({
      args: ["--state-dir", state, ...arguments_],
      git: outsideRepositoryGit,
      env: { HOME: home },
      ...(terminal === undefined ? {} : { terminal }),
    }).pipe(Effect.provideService(Source, { ...source, builtInSources: [builtInSource] }));
  return {
    at,
    fileSystem,
    state,
    json: (arguments_: ReadonlyArray<string>) =>
      run(["--json", ...arguments_]).pipe(Effect.map(({ stdout }) => decodeEnvelope(stdout))),
    text: (arguments_: ReadonlyArray<string>) =>
      run(arguments_, pipe).pipe(Effect.map(({ stdout }) => stdout)),
  };
});

it.layer(LiveTestLayer)("tack init", (initIt) => {
  initIt.effect("sets up a new machine at once and says what it wrote", () =>
    Effect.gen(function* () {
      const { at, fileSystem, state, text } = yield* machine([".claude/skills/my-own", ".agents"]);
      const output = yield* text(["init"]);
      expect(output.replaceAll(/\s+/g, " ")).toContain(
        `Created ${state}. Enabled claude, codex. Linked ${builtIns.length * 2} skills at user scope.`,
      );
      expect(output).toContain("applied  create  .claude/skills/use-tack");
      expect(output).toContain("Hand-made, left untouched\n");
      expect(output).toContain("folder · claude skill\n");
      expect(output.endsWith("Next\n  tack guide onboarding\n  tack source add PATH\n")).toBe(true);
      expect(yield* fileSystem.exists(`${state}/.env`)).toBe(true);
      for (const name of builtIns) {
        expect(yield* fileSystem.readLink(at(".claude/skills", name))).toContain(name);
        expect(yield* fileSystem.readLink(at(".agents/skills", name))).toContain(name);
      }
      // A hand-made entry is left as it was.
      expect(yield* fileSystem.readDirectory(at(".claude/skills/my-own"))).toEqual([]);
    }),
  );

  initIt.effect("reports the plan and its application, then has nothing left to write", () =>
    Effect.gen(function* () {
      const { at, fileSystem, json, state, text } = yield* machine([
        ".claude/skills/my-own",
        ".agents",
      ]);
      const envelope = yield* json(["init"]);
      expect(envelope).toMatchObject({
        command: "init",
        status: "success",
        next: ["tack guide onboarding", "tack source add PATH"],
      });
      expect(planOf(envelope)).toMatchObject({
        stateDirectory: state,
        state: "create",
        adapters: {
          enabled: [],
          toEnable: ["claude", "codex"],
          // Codex is found by its skill folder when it has no `.codex` of its own.
          detection: [
            { adapter: "claude", home: at(".claude"), found: true },
            { adapter: "codex", home: at(".agents"), found: true },
            { adapter: "cursor", home: at(".cursor"), found: false },
          ],
          source: "detected",
        },
        handMade: [
          {
            adapter: "claude",
            kind: "skill",
            path: at(".claude/skills/my-own"),
            entry: "directory",
          },
        ],
      });
      expect(appliedOf(envelope)).toMatchObject({
        state: "created",
        adaptersEnabled: ["claude", "codex"],
        user: { kind: "sync-application" },
      });
      const plan = planOf(envelope);
      // The user part is the plan `sync --user` makes once the agents are enabled.
      expect(
        plan.user.resources?.units.map(({ adapter, summary }) => [adapter, summary.create]),
      ).toEqual([
        ["claude", builtIns.length],
        ["codex", builtIns.length],
      ]);
      // The guide is a command in `next`, not a path an agent must find outside its project.
      expect(envelope.plan).not.toHaveProperty("guide");

      // A rerun is safe: it writes nothing and leaves the hand-made entry alone.
      const rerun = yield* json(["init"]);
      expect(rerun).toMatchObject({ status: "success", next: ["tack doctor"] });
      expect(planOf(rerun)).toMatchObject({
        state: "exists",
        adapters: { enabled: ["claude", "codex"], toEnable: [] },
        handMade: [{ path: at(".claude/skills/my-own") }],
      });
      expect(appliedOf(rerun)).toMatchObject({ state: "existed", adaptersEnabled: [] });
      expect(yield* text(["init"])).toContain(
        "Nothing was written: Tack was already set up on this machine.",
      );
      expect(yield* fileSystem.readDirectory(at(".claude/skills/my-own"))).toEqual([]);
    }),
  );

  initIt.effect("has no --apply flag", () =>
    Effect.gen(function* () {
      const { fileSystem, json, state } = yield* machine([".claude"]);
      expect(yield* json(["init", "--apply"])).toMatchObject({
        classification: "invalid-invocation",
      });
      expect(yield* fileSystem.exists(state)).toBe(false);
    }),
  );

  initIt.effect("enables only the agents --adapter names, and never disables one", () =>
    Effect.gen(function* () {
      const { json, text } = yield* machine([".claude"]);
      const named = yield* json(["init", "--adapter", "cursor"]);
      expect(planOf(named).adapters).toMatchObject({
        enabled: [],
        toEnable: ["cursor"],
        source: "requested",
      });
      expect(appliedOf(named)).toMatchObject({ adaptersEnabled: ["cursor"] });
      expect(yield* text(["init", "--adapter", "cursor"])).toContain(
        "found  named with --adapter; not detected",
      );
      // Detection adds the agent it finds beside the requested one, which stays enabled.
      expect(planOf(yield* json(["init"])).adapters).toMatchObject({
        enabled: ["cursor"],
        toEnable: ["claude"],
      });
    }),
  );

  initIt.effect("sets up only the state when it finds no agent", () =>
    Effect.gen(function* () {
      const { fileSystem, json, state } = yield* machine([]);
      const envelope = yield* json(["init"]);
      expect(envelope).toMatchObject({
        status: "partial",
        next: ["tack guide onboarding", "tack init --adapter claude"],
        diagnostics: [{ code: "agent-home-not-found", severity: "warning" }],
      });
      expect(envelope.diagnostics[0]?.message).toContain(
        "it looks for .claude, .codex, .agents, .cursor",
      );
      expect(appliedOf(envelope)).toMatchObject({ state: "created", adaptersEnabled: [] });
      expect(yield* fileSystem.exists(`${state}/state.json`)).toBe(true);
    }),
  );

  initIt.effect("links everything else around a hand-made entry at a built-in's path", () =>
    Effect.gen(function* () {
      const { at, fileSystem, json, text } = yield* machine([".claude/skills/use-tack"]);
      yield* fileSystem.writeFileString(at(".claude/skills/use-tack/SKILL.md"), "mine\n");
      expect(yield* json(["init"])).toMatchObject({
        status: "partial",
        diagnostics: [{ code: "foreign-destination" }],
        next: ["tack guide onboarding", "tack status --user", "tack source add PATH"],
      });
      expect(
        yield* fileSystem.readLink(at(".claude/skills/use-tack/../manage-tack-sources")),
      ).toContain("manage-tack-sources");
      expect(yield* fileSystem.readFileString(at(".claude/skills/use-tack/SKILL.md"))).toBe(
        "mine\n",
      );
      // Set up, but the one conflict still needs the operator.
      expect(yield* json(["init"])).toMatchObject({
        status: "partial",
        next: ["tack status --user", "tack doctor"],
      });
      expect(yield* text(["init"])).toContain(
        "Nothing was written: Tack was already set up on this machine. 1 item needs attention.",
      );
    }),
  );

  initIt.effect("writes nothing when this release cannot read the state", () =>
    Effect.gen(function* () {
      const { fileSystem, json, state } = yield* machine([".claude"]);
      yield* fileSystem.makeDirectory(state, { recursive: true });
      yield* fileSystem.writeFileString(`${state}/state.json`, '{"format":99,"data":{}}\n');
      expect(yield* json(["init"])).toMatchObject({
        status: "failure",
        diagnostics: [{ code: "state-format-unsupported" }],
      });
      expect(yield* fileSystem.readFileString(`${state}/state.json`)).toBe(
        '{"format":99,"data":{}}\n',
      );
    }),
  );
});
