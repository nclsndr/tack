import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  envelope,
  expectSuccess,
  isolationOf,
  withFixture,
  type CliFixture,
} from "./support/envelope-fixture.ts";
import {
  builtEntrypoint,
  repositoryRoot,
  sourceEntrypoint,
  tackEnvironment,
  tackProcess,
} from "./support/tack-process.ts";

/** Runs one Tack entrypoint with `--json` against the fixture's isolated home and state. */
const runTack = (
  entrypoint: string,
  fixture: CliFixture,
  arguments_: ReadonlyArray<string>,
  cwd: string = fixture.repositoryDirectory,
) => tackProcess(["--json", ...arguments_], { ...isolationOf(fixture), cwd, entrypoint });

// The cases that need a process: a held lock, a killed writer, the built package, and the
// process-level smoke test of format 1 envelopes. The other cases run in process, in
// `command-envelope.host.test.ts`.
it.layer(LiveTestLayer)("command envelope at the process boundary", (cliIt) => {
  cliIt.effect("reports a held state lock without changing bytes at the process boundary", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const holderEntrypoint = path.join(
          repositoryRoot,
          "apps/cli/test/fixtures/hold-state-lock.ts",
        );
        const statePath = path.join(fixture.stateDirectory, "state.json");
        expectSuccess(yield* runTack(sourceEntrypoint, fixture, ["state", "init"]));
        const stateBefore = yield* fileSystem.readFileString(statePath);
        const holder = yield* ChildProcess.make(process.execPath, [holderEntrypoint], {
          cwd: fixture.repositoryDirectory,
          env: tackEnvironment(isolationOf(fixture)),
        });
        const ready = yield* holder.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runHead,
        );

        expect(ready).toMatchObject({ _tag: "Some", value: "ready" });
        const result = yield* runTack(sourceEntrypoint, fixture, [
          "source",
          "add",
          fixture.sourceDirectory,
          "--apply",
        ]);
        yield* holder.kill();

        expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
        expect(result.stderr).toBe("");
        expect(envelope(result)).toMatchObject({
          classification: "domain",
          diagnostics: [
            expect.objectContaining({
              code: "state-busy",
              message: expect.stringContaining(path.join(fixture.stateDirectory, "state.lock")),
            }),
          ],
          status: "failure",
        });
        expect(yield* fileSystem.readFileString(statePath)).toBe(stateBefore);
      }),
    ),
  );

  cliIt.effect("takes over a state lock after its writer is killed", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const holderEntrypoint = path.join(
          repositoryRoot,
          "apps/cli/test/fixtures/hold-state-lock.ts",
        );
        const lockPath = path.join(fixture.stateDirectory, "state.lock");
        const statePath = path.join(fixture.stateDirectory, "state.json");
        const temporaryPath = `${statePath}.tmp-orphan`;
        const backupPath = path.join(fixture.stateDirectory, "state.json.v1-backup.keep.json");
        const historyPath = path.join(fixture.stateDirectory, "history");
        expectSuccess(yield* runTack(sourceEntrypoint, fixture, ["state", "init"]));
        const holder = yield* ChildProcess.make(process.execPath, [holderEntrypoint], {
          cwd: fixture.repositoryDirectory,
          env: tackEnvironment(isolationOf(fixture)),
        });
        const ready = yield* holder.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runHead,
        );
        expect(ready).toMatchObject({ _tag: "Some", value: "ready" });
        expect(yield* fileSystem.exists(lockPath)).toBe(true);
        expect(yield* fileSystem.readFileString(lockPath)).toMatch(/^\d+\n$/);
        expectSuccess(yield* runTack(sourceEntrypoint, fixture, ["catalog"]));
        yield* holder.kill({ killSignal: "SIGKILL" });
        expectSuccess(yield* runTack(sourceEntrypoint, fixture, ["catalog"]));
        expect(yield* fileSystem.exists(lockPath)).toBe(true);
        yield* fileSystem.writeFileString(temporaryPath, "orphan");
        yield* fileSystem.writeFileString(backupPath, "backup");
        yield* fileSystem.makeDirectory(historyPath);
        yield* fileSystem.writeFileString(path.join(historyPath, "entry"), "history");

        const result = yield* runTack(sourceEntrypoint, fixture, ["state", "init"]);

        expectSuccess(result);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
        expect(yield* fileSystem.exists(temporaryPath)).toBe(false);
        expect(yield* fileSystem.readFileString(backupPath)).toBe("backup");
        expect(yield* fileSystem.readFileString(path.join(historyPath, "entry"))).toBe("history");
      }),
    ),
  );

  cliIt.effect("recovers all ten pre- and post-rename SIGKILL points", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crashEntrypoint = path.join(
        repositoryRoot,
        "apps/cli/test/fixtures/crash-state-writes.ts",
      );
      for (const point of ["before-rename", "after-rename"]) {
        for (let write = 1; write <= 5; write += 1) {
          yield* withFixture((fixture) =>
            Effect.gen(function* () {
              const child = yield* ChildProcess.make(process.execPath, [crashEntrypoint], {
                cwd: fixture.repositoryDirectory,
                env: tackEnvironment(isolationOf(fixture), {
                  TACK_TEST_CRASH_AT: String(write),
                  TACK_TEST_CRASH_POINT: point,
                }),
              });
              const crash = yield* Effect.flip(child.exitCode);
              expect(crash, `${point} write ${write}`).toMatchObject({
                reason: {
                  cause: expect.objectContaining({ message: expect.stringContaining("SIGKILL") }),
                },
              });
              expect(
                yield* fileSystem.exists(path.join(fixture.stateDirectory, "state.lock")),
              ).toBe(true);
              const recovered = yield* runTack(sourceEntrypoint, fixture, ["state", "init"]);
              expect(recovered.exitCode, `${point} write ${write}: ${recovered.stdout}`).toBe(
                ChildProcessSpawner.ExitCode(0),
              );
              expect(
                yield* fileSystem.exists(path.join(fixture.stateDirectory, "state.lock")),
              ).toBe(false);
              expect(
                (yield* fileSystem.readDirectory(fixture.stateDirectory)).filter((entry) =>
                  entry.startsWith("state.json.tmp-"),
                ),
              ).toEqual([]);
            }),
          );
        }
      }
    }),
  );

  cliIt.effect("emits deterministic format 1 command envelopes", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixtureRoot = path.dirname(fixture.homeDirectory);
        const captures: Array<{ command: string; stdout: string }> = [];
        const capture = (command: ReadonlyArray<string>, stdout: string) => {
          captures.push({
            command: command.join(" ").replaceAll(fixtureRoot, "<FIXTURE>"),
            stdout: stdout
              .replaceAll(fixtureRoot, "<FIXTURE>")
              .replaceAll(repositoryRoot, "<REPOSITORY>")
              .replace(/(?:\.\.\/)*\.\.<REPOSITORY>/g, "<REPOSITORY-RELATIVE>")
              .replaceAll(
                /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
                "<UUID>",
              ),
          });
        };
        for (const command of [
          ["state", "init"],
          ["source", "add", fixture.sourceDirectory, "--apply"],
          ["adapter", "enable", "codex"],
          ["sync", "--user"],
          ["sync", "--user", "--apply"],
          ["status", "--user"],
        ]) {
          const result = yield* runTack(sourceEntrypoint, fixture, command);
          expectSuccess(result);
          capture(command, result.stdout);
        }
        yield* fileSystem.remove(path.join(fixture.homeDirectory, ".agents", "skills", "valid"));
        const driftCommand = ["status", "--user"];
        const drift = yield* runTack(sourceEntrypoint, fixture, driftCommand);
        expect(drift.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
        expect(envelope(drift).status).toBe("partial");
        capture(driftCommand, drift.stdout);
        const resetCommand = ["state", "reset", "--apply"];
        const reset = yield* runTack(sourceEntrypoint, fixture, resetCommand);
        expectSuccess(reset);
        capture(resetCommand, reset.stdout);

        expect(captures).toHaveLength(8);
        expect(captures[0]?.stdout).toContain('"command":"state init"');
        expect(captures[4]?.stdout).toContain('"kind":"sync-application"');
      }),
    ),
  );

  cliIt.effect(
    "keeps source and built catalogs equivalent apart from installation-relative asset paths",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          expectSuccess(yield* runTack(sourceEntrypoint, fixture, ["state", "init"]));

          const sourceCatalog = yield* runTack(sourceEntrypoint, fixture, ["catalog"]);
          const builtCatalog = yield* runTack(builtEntrypoint, fixture, ["catalog"]);

          expectSuccess(sourceCatalog);
          expectSuccess(builtCatalog);
          expect(builtCatalog.stdout).toBe(
            sourceCatalog.stdout.replaceAll(
              path.resolve("apps/cli/src/builtins"),
              path.resolve("apps/cli/dist/builtins"),
            ),
          );
          const fs = yield* FileSystem.FileSystem;
          const installed = path.join(
            path.dirname(fixture.repositoryDirectory),
            "installed release",
          );
          const installedEntrypoint = path.join(installed, "main.js");
          yield* fs.makeDirectory(installed);
          yield* fs.copyFile(builtEntrypoint, installedEntrypoint);
          yield* fs.copy(path.resolve("apps/cli/dist/builtins"), path.join(installed, "builtins"));
          // Reader dependencies remain external; this test verifies bundled resource relocation.
          yield* fs.symlink(
            path.resolve("apps/cli/node_modules"),
            path.join(installed, "node_modules"),
          );
          const installedCatalog = yield* runTack(installedEntrypoint, fixture, ["catalog"]);
          expectSuccess(installedCatalog);
          expect(installedCatalog.stdout).toBe(
            builtCatalog.stdout.replaceAll(
              path.resolve("apps/cli/dist/builtins"),
              path.join(installed, "builtins"),
            ),
          );
          expectSuccess(
            yield* runTack(installedEntrypoint, fixture, ["adapter", "enable", "codex"]),
          );
          expectSuccess(
            yield* runTack(installedEntrypoint, fixture, ["sync", "--user", "--apply"]),
          );
          const destination = path.join(fixture.homeDirectory, ".agents/skills/use-tack");
          expect(yield* fs.realPath(destination)).toBe(
            path.join(installed, "builtins/skills/use-tack"),
          );
          // Retain the old release until its managed links have been verified and replaced.
          const upgraded = `${installed} next`;
          yield* fs.copy(installed, upgraded);
          const upgradedEntrypoint = path.join(upgraded, "main.js");
          expectSuccess(yield* runTack(upgradedEntrypoint, fixture, ["sync", "--user", "--apply"]));
          expect(yield* fs.realPath(destination)).toBe(
            path.join(upgraded, "builtins/skills/use-tack"),
          );
          yield* fs.rename(path.join(upgraded, "builtins"), path.join(upgraded, "unavailable"));
          const unavailable = yield* runTack(upgradedEntrypoint, fixture, ["catalog"]);
          expect(unavailable.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
          expect(envelope(unavailable).result).toMatchObject({
            complete: false,
            issues: [{ code: "source-missing", subject: { _tag: "source", origin: "builtin" } }],
          });
          yield* fs.rename(path.join(upgraded, "unavailable"), path.join(upgraded, "builtins"));
          expectSuccess(yield* runTack(upgradedEntrypoint, fixture, ["catalog"]));
        }),
      ),
  );
});
