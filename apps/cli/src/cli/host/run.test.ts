import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Ref, Schema, Sink, Stdio, Stream } from "effect";
import { vi } from "vitest";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { mutateState } from "../../../test/support/state-fixture.ts";
import { Git } from "../../services/git.ts";
import { PublicEnvelopeSchema } from "./public-outcome.ts";
import { runCli } from "./run.ts";

const decodeEnvelope = Schema.decodeUnknownSync(PublicEnvelopeSchema);
const text = (chunk: string | Uint8Array) =>
  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

/**
 * A throwaway world: a source `tools` declaring the docs resource `handbook`, a project `demo` with
 * one root, and a host that runs `tack --json` in process against them.
 */
const world = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-run-host-" }));
  const project = path.join(root, "project");
  const source = path.join(root, "tools");
  const anchor = path.join(root, "git");
  yield* Effect.forEach([project, anchor, path.join(source, "docs")], (directory) =>
    fs.makeDirectory(directory, { recursive: true }),
  );
  yield* fs.writeFileString(
    path.join(source, "tack.yaml"),
    "version: 2\nname: tools\ndocs: [{name: handbook, path: docs}]\n",
  );
  yield* fs.writeFileString(path.join(source, "docs", "index.md"), "# Handbook\n");
  const git = Git.of({
    listWorktrees: () => Effect.succeed([{ path: project, bare: false, detached: false }]),
    resolveCommonDirectory: () => Effect.succeed(anchor),
  });
  const state = path.join(root, "state");
  /** Runs one invocation; `stateDirectory: false` leaves the state location to the environment. */
  const tack = (words: ReadonlyArray<string>, stateDirectory = true) =>
    Effect.gen(function* () {
      const stdout = yield* Ref.make("");
      yield* Effect.exit(
        runCli().pipe(
          Effect.provideService(Git, git),
          Effect.provideService(
            Stdio.Stdio,
            Stdio.make({
              args: Effect.succeed([
                "--json",
                ...(stateDirectory ? ["--state-dir", state] : []),
                ...words,
              ]),
              stdin: Stream.empty,
              stderr: () => Sink.drain,
              stdout: () =>
                Sink.forEach((chunk: string | Uint8Array) =>
                  Ref.update(stdout, (output) => output + text(chunk)),
                ),
            }),
          ),
        ),
      );
      return decodeEnvelope(JSON.parse(yield* Ref.get(stdout)));
    });
  const setUp = Effect.gen(function* () {
    for (const words of [
      ["state", "init"],
      ["source", "add", source, "--apply"],
      ["project", "add", "demo", "--repository-cwd", project],
      ["docs", "attach", "tools:handbook", "--project", "demo"],
    ])
      expect((yield* tack(words)).status).toBe("success");
  });
  return { fs, path, root, project, source, state, tack, setUp };
});

it.layer(LiveTestLayer)("CLI host", (test) => {
  test.effect("names the attached resource a docs target asks for", () =>
    Effect.gen(function* () {
      const { tack, setUp, project } = yield* world;
      yield* setUp;
      expect((yield* tack(["sync", "--project", "demo", "--apply"])).status).toBe("success");
      const target = yield* tack(["docs", "target", "--name", "handbook", "--project", "demo"]);
      expect(target).toMatchObject({
        classification: "success",
        result: { kind: "docs-target", resource: { name: "handbook" } },
      });
      expect(JSON.stringify(target.result)).toContain(`${project}/.tack/docs/`);
    }),
  );

  test.effect("warns about each owed docs removal a sync preview covers", () =>
    Effect.gen(function* () {
      const { tack, setUp, root } = yield* world;
      yield* setUp;
      yield* tack(["sync", "--project", "demo", "--apply"]);
      // The mount's removal is owed, as after a removal that could not finish.
      yield* mutateState({ environment: { TACK_STATE_DIR: `${root}/state` } }, (current) => ({
        ...current,
        data: {
          ...current.data,
          links: current.data.links.map((record) => ({ ...record, removal: { cause: "clean" } })),
        },
      }));
      const preview = yield* tack(["sync", "--project", "demo"]);
      expect(preview).toMatchObject({
        classification: "partial",
        diagnostics: [{ code: "pending-removal", severity: "warning" }],
        plan: { docsPendingRemovals: [{ cause: "clean" }] },
      });
    }),
  );

  test.effect("reports a project refresh whose docs mount is occupied as partial", () =>
    Effect.gen(function* () {
      const { fs, path, tack, setUp, project } = yield* world;
      yield* setUp;
      const planned = yield* tack(["sync", "--project", "demo"]);
      const destination = JSON.stringify(planned.plan).match(/"destinationPath":"([^"]+)"/)?.[1];
      if (destination === undefined) throw new Error("The sync plans no docs mount.");
      yield* fs.makeDirectory(path.join(destination, "foreign"), { recursive: true });
      const refresh = yield* tack(["project", "refresh", "--cwd", project]);
      expect(refresh).toMatchObject({
        classification: "partial",
        diagnostics: [{ code: "project-refresh-docs-partial", severity: "warning" }],
        plan: { selection: { cwd: project } },
      });
    }),
  );

  test.effect("answers version and icon lookups without reading state", () =>
    Effect.gen(function* () {
      const { fs, tack, state } = yield* world;
      expect(yield* tack(["--version"])).toMatchObject({
        classification: "success",
        command: "version",
        result: { kind: "version" },
      });
      expect(yield* tack(["docs", "icons", "book"])).toMatchObject({
        classification: "success",
        command: "docs icons",
        result: { kind: "docs-icons", query: "book" },
      });
      expect(yield* tack(["docs", "icons", "zzzz"])).toMatchObject({
        classification: "success",
        diagnostics: [{ code: "docs-icons-none", severity: "warning" }],
        result: { count: 0 },
      });
      expect(yield* fs.exists(state)).toBe(false);
    }),
  );
});

/** Runs an effect with environment variables stubbed, restoring them however it ends. */
const withEnvironment = <A, E, R>(
  variables: Readonly<Record<string, string | undefined>>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.sync(() => {
    for (const [name, value] of Object.entries(variables)) vi.stubEnv(name, value);
  }).pipe(Effect.andThen(effect), Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));

it.layer(LiveTestLayer)("CLI host environment", (test) => {
  test.effect("needs HOME to locate the default state", () =>
    Effect.gen(function* () {
      const { tack } = yield* world;
      const envelope = yield* withEnvironment(
        { HOME: undefined, TACK_STATE_DIR: undefined },
        tack(["catalog"], false),
      );
      expect(envelope).toMatchObject({
        classification: "invalid-configuration",
        diagnostics: [{ code: "home-directory-unavailable" }],
      });
    }),
  );

  test.effect("initializes the default state on the first mutation and says where", () =>
    Effect.gen(function* () {
      const { fs, path, root, source, tack } = yield* world;
      const home = path.join(root, "home");
      yield* fs.makeDirectory(home);
      const first = yield* inHome(home, tack(["source", "add", source, "--apply"], false));
      const stateDirectory = path.join(home, ".tack");
      expect(first.diagnostics).toContainEqual({
        code: "state-initialized",
        severity: "info",
        message: `Initialized Tack state at ${stateDirectory}. No agent folder was found in this home, so no agent is enabled: run \`tack init --adapter <adapter>\` to enable one.`,
        details: { stateDirectory, enabledAdapters: [] },
      });
      expect(yield* fs.exists(path.join(stateDirectory, "state.json"))).toBe(true);
    }),
  );

  test.effect("enables the agents found in the home when it initializes the default state", () =>
    Effect.gen(function* () {
      const { fs, path, root, source, tack } = yield* world;
      const home = path.join(root, "home");
      yield* fs.makeDirectory(path.join(home, ".claude"), { recursive: true });
      const first = yield* inHome(home, tack(["source", "add", source, "--apply"], false));
      const stateDirectory = path.join(home, ".tack");
      expect(first.diagnostics).toContainEqual({
        code: "state-initialized",
        severity: "info",
        message: `Initialized Tack state at ${stateDirectory} and enabled the agents found in this home: claude. \`tack init\` also links the built-in skills.`,
        details: { stateDirectory, enabledAdapters: ["claude"] },
      });
      const adapters = yield* inHome(home, tack(["adapter", "list"], false));
      expect(JSON.stringify(adapters.result)).toContain('"claude"');
    }),
  );

  test.effect("enables only the named adapter when adapter enable initializes the state", () =>
    Effect.gen(function* () {
      const { fs, path, root, tack } = yield* world;
      const home = path.join(root, "home");
      yield* fs.makeDirectory(path.join(home, ".claude"), { recursive: true });
      const enabled = yield* inHome(home, tack(["adapter", "enable", "codex"], false));
      const stateDirectory = path.join(home, ".tack");
      expect(enabled.diagnostics).toContainEqual({
        code: "state-initialized",
        severity: "info",
        message: `Initialized Tack state at ${stateDirectory}.`,
        details: { stateDirectory },
      });
      const adapters = yield* inHome(home, tack(["adapter", "list"], false));
      expect(JSON.stringify(adapters.result)).not.toContain('"claude"');
    }),
  );

  test.effect("scaffolds a source on a new machine as plain registration does", () =>
    Effect.gen(function* () {
      const { fs, path, root, tack } = yield* world;
      const home = path.join(root, "home");
      const folder = path.join(root, "agent-setup");
      yield* fs.makeDirectory(path.join(home, ".claude"), { recursive: true });
      yield* fs.makeDirectory(path.join(folder, "skills", "review"), { recursive: true });
      yield* fs.writeFileString(
        path.join(folder, "skills", "review", "SKILL.md"),
        "---\nname: review\ndescription: Review a change.\n---\nReview.\n",
      );
      const stateDirectory = path.join(home, ".tack");
      const words = ["source", "add", folder, "--skills", "skills"];
      const preview = yield* inHome(home, tack(words, false));
      expect(preview).toMatchObject({ classification: "success" });
      expect(preview.diagnostics).toEqual([
        {
          code: "state-initialization-planned",
          severity: "info",
          message: `Tack state does not exist yet: --apply initializes it at ${stateDirectory} and enables the agents found in this home: claude.`,
          details: { stateDirectory, enabledAdapters: ["claude"] },
        },
      ]);
      expect(yield* fs.exists(stateDirectory)).toBe(false);
      expect(yield* fs.exists(path.join(folder, "tack.yaml"))).toBe(false);

      const applied = yield* inHome(home, tack([...words, "--apply"], false));
      expect(applied).toMatchObject({ classification: "success" });
      expect(applied.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "state-initialized",
          details: { stateDirectory, enabledAdapters: ["claude"] },
        }),
      );
      expect(yield* fs.exists(path.join(folder, "tack.yaml"))).toBe(true);
    }),
  );

  test.effect("refuses to scaffold a source into an explicit state directory that is absent", () =>
    Effect.gen(function* () {
      const { fs, path, root, tack } = yield* world;
      const folder = path.join(root, "agent-setup");
      yield* fs.makeDirectory(path.join(folder, "skills", "review"), { recursive: true });
      yield* fs.writeFileString(
        path.join(folder, "skills", "review", "SKILL.md"),
        "---\nname: review\ndescription: Review a change.\n---\nReview.\n",
      );
      const applied = yield* tack(["source", "add", folder, "--skills", "skills", "--apply"]);
      expect(applied).toMatchObject({
        classification: "invalid-configuration",
        diagnostics: [{ code: "state-not-initialized" }],
      });
      expect(yield* fs.exists(path.join(folder, "tack.yaml"))).toBe(false);
    }),
  );
});

/** Runs a host invocation against the default state under `home`, never the real home. */
const inHome = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
  withEnvironment(
    { HOME: home, TACK_STATE_DIR: undefined },
    Effect.gen(function* () {
      // Never let this test reach a real home directory.
      if (process.env["HOME"] !== home) return yield* Effect.die("HOME is not isolated.");
      return yield* effect;
    }),
  );
