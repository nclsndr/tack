import { mutateState } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ExecutionPlatformLive } from "../../platform/execution/execution-platform.ts";
import { ImportFetchError, ImportRemote } from "../../services/import-remote.ts";
import { initializeState, type StateOptions } from "../../services/state-store.ts";
import { registerSource } from "../sources/source.ts";
import { attachDocs } from "../docs/docs.ts";
import { syncDocs } from "../../../test/support/reconciliation.ts";
import { runDoctor } from "./doctor.ts";
import { BunServices } from "@effect/platform-bun";
import { parseInvocation } from "../../cli/commands/index.ts";
import { Git } from "../../services/git.ts";
import { outsideRepositoryGit } from "../../../test/support/fake-git.ts";

/** Every command a report names, so the last test can parse each one. */
const named: Array<ReadonlyArray<string>> = [];

/** Runs doctor for one home and state, from a directory outside any repository. */
const doctorIn = (options: StateOptions, home: string) =>
  runDoctor(options, home).pipe(
    Effect.provide(ExecutionPlatformLive),
    Effect.provideService(Git, outsideRepositoryGit),
    Effect.tap((report) =>
      Effect.sync(() =>
        named.push(...report.checks.flatMap(({ next }) => (next === undefined ? [] : [next]))),
      ),
    ),
  );

const checkOf = (report: Effect.Success<ReturnType<typeof doctorIn>>, id: string) =>
  report.checks.find((check) => check.id === id);

const temporaryHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-doctor-unit-" }));
});

/** A state with one project, `demo`, and one registered source that declares a docs resource. */
const docsWorld = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* temporaryHome;
  const stateDirectory = path.join(home, "state");
  const options = { environment: { TACK_STATE_DIR: stateDirectory }, homeDirectory: home };
  yield* initializeState(options);
  const root = path.join(home, "project");
  yield* fs.makeDirectory(root);
  yield* mutateState(options, (state) => ({
    ...state,
    data: {
      ...state.data,
      projects: [{ name: "demo", gitCommonDirectory: path.join(home, "git"), roots: [root] }],
    },
  }));
  const source = path.join(home, "source");
  yield* fs.makeDirectory(path.join(source, "knowledge"), { recursive: true });
  yield* fs.makeDirectory(path.join(source, "reader"));
  yield* fs.writeFileString(path.join(source, "reader", "handbook.json"), "{}\n");
  yield* fs.writeFileString(path.join(source, "knowledge", "hello.md"), "# Hello\n");
  const declare = (reader: string) =>
    fs.writeFileString(
      path.join(source, "tack.yaml"),
      `version: 1\ndocs:\n  - name: handbook\n    path: knowledge\n${reader}`,
    );
  yield* declare("");
  const registered = yield* registerSource(options, { sourcePath: source });
  const sourceId = registered.registration.id;
  return {
    options,
    home,
    root,
    source,
    sourceId,
    stateDirectory,
    declare,
    mount: path.join(root, ".tack", "docs", sourceId, "handbook"),
  };
});

it.layer(LiveTestLayer)("doctor", (doctorIt) => {
  doctorIt.effect("reports a missing default state and skips every check that reads it", () =>
    Effect.gen(function* () {
      const home = yield* temporaryHome;
      const report = yield* doctorIn({ environment: {}, homeDirectory: home }, home);
      // No `--state-dir` is suggested when the operator relies on the default state directory.
      expect(checkOf(report, "state")).toMatchObject({
        outcome: "warning",
        next: ["tack", "init"],
      });
      expect(checkOf(report, "links")).toEqual({
        id: "links",
        outcome: "skipped",
        message: "Not observed: there is no state to read.",
      });
      expect(report.summary.skipped).toBe(9);
      expect(report.summary.total).toBe(report.checks.length);
    }),
  );

  doctorIt.effect("points a fresh state at tack init and registering a source", () =>
    Effect.gen(function* () {
      const home = yield* temporaryHome;
      const options = { environment: {}, homeDirectory: home };
      yield* initializeState(options);
      const report = yield* doctorIn(options, home);
      expect(checkOf(report, "adapters")).toMatchObject({
        outcome: "warning",
        next: ["tack", "init"],
      });
      // The built-in source is always there, but the operator has registered nothing yet.
      expect(checkOf(report, "sources")).toMatchObject({
        outcome: "warning",
        next: ["tack", "source", "add", "PATH"],
      });
    }),
  );

  doctorIt.effect("fails a state written in a newer format and does not read past it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* temporaryHome;
      const stateDirectory = path.join(home, "state");
      yield* fs.makeDirectory(stateDirectory);
      yield* fs.writeFileString(
        path.join(stateDirectory, "state.json"),
        '{"format":99,"data":{}}\n',
      );
      const report = yield* doctorIn(
        { environment: { TACK_STATE_DIR: stateDirectory }, homeDirectory: home },
        home,
      );
      expect(checkOf(report, "state")).toMatchObject({
        outcome: "failed",
        message: expect.stringContaining("State format 99"),
        next: ["tack", "upgrade"],
      });
      expect(checkOf(report, "docs")).toEqual({
        id: "docs",
        outcome: "skipped",
        message: "Not observed: this release cannot read the state.",
      });
    }),
  );

  doctorIt.effect(
    "warns about unreadable run records and a git that cannot fetch, and reports the version",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { options, home, stateDirectory } = yield* docsWorld;
        const history = path.join(stateDirectory, "history");
        yield* fs.makeDirectory(history, { recursive: true });
        const records = [crypto.randomUUID(), crypto.randomUUID()].map((id) =>
          path.join(history, `${id}.json`),
        );
        for (const record of records) yield* fs.writeFileString(record, "{}");
        const report = yield* doctorIn(options, home).pipe(
          Effect.provideService(ImportRemote, {
            limits: (yield* ImportRemote).limits,
            probe: Effect.fail(
              new ImportFetchError({
                code: "import-git-unavailable",
                message: "git is not installed.",
              }),
            ),
            listRefs: () => Effect.die("doctor never lists refs"),
            open: () => Effect.die("doctor never fetches"),
          }),
        );
        expect(checkOf(report, "state")).toEqual({
          id: "state",
          outcome: "warning",
          message: "2 retained script run records could not be read.",
          subjects: records.toSorted(),
          next: ["tack", "script", "history", "--state-dir", stateDirectory],
        });
        expect(checkOf(report, "release")).toMatchObject({
          outcome: "ok",
          message: expect.stringContaining("tack upgrade names the command that upgrades it"),
        });
        expect(checkOf(report, "imports")).toEqual({
          id: "imports",
          outcome: "warning",
          message: "git is not installed. `tack import add` needs git to fetch.",
        });

        yield* fs.remove(records[1] ?? "");
        const single = yield* doctorIn(options, home);
        expect(checkOf(single, "state")?.message).toBe(
          "1 retained script run record could not be read.",
        );
      }),
  );

  doctorIt.effect("follows attached docs from unmounted to mounted to failing to load", () =>
    Effect.gen(function* () {
      const { options, home, sourceId, stateDirectory, declare } = yield* docsWorld;
      const withoutDocs = yield* doctorIn(options, home);
      expect(checkOf(withoutDocs, "docs")).toEqual({
        id: "docs",
        outcome: "skipped",
        message: "No docs resource is attached to a project.",
      });

      yield* attachDocs(options, { projectName: "demo" }, { reference: `${sourceId}:handbook` });
      expect(checkOf(yield* doctorIn(options, home), "docs")).toEqual({
        id: "docs",
        outcome: "warning",
        message: "1 project with an attached docs resource that is not mounted.",
        subjects: ["demo"],
        next: ["tack", "sync", "--project", "demo", "--state-dir", stateDirectory],
      });

      yield* syncDocs(options, { projectName: "demo", apply: true });
      expect(checkOf(yield* doctorIn(options, home), "docs")).toEqual({
        id: "docs",
        outcome: "ok",
        message: "1 project with attached docs, all mounted and loading.",
      });

      // A mounted resource whose reader settings cannot load is inspected, not re-synced.
      yield* declare("    reader: reader/handbook.json\n");
      expect(checkOf(yield* doctorIn(options, home), "docs")).toEqual({
        id: "docs",
        outcome: "failed",
        message:
          "1 project with a docs resource or document that fails to load, or a conflicting mount.",
        subjects: ["demo"],
        next: ["tack", "docs", "--project", "demo", "--state-dir", stateDirectory],
      });
    }),
  );

  doctorIt.effect("fails on a conflicting docs mount and points at the project sync", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { options, home, sourceId, stateDirectory, mount } = yield* docsWorld;
      yield* attachDocs(options, { projectName: "demo" }, { reference: `${sourceId}:handbook` });
      yield* fs.makeDirectory(mount, { recursive: true });
      expect(checkOf(yield* doctorIn(options, home), "docs")).toEqual({
        id: "docs",
        outcome: "failed",
        message:
          "1 project with a docs resource or document that fails to load, or a conflicting mount.",
        subjects: ["demo"],
        next: ["tack", "sync", "--project", "demo", "--state-dir", stateDirectory],
      });
    }),
  );
});

// Runs last: the reports above name the commands of the checks doctor itself builds.
it.effect("names only commands the CLI parses", () =>
  Effect.gen(function* () {
    expect(named.some((argv) => argv.includes("init"))).toBe(true);
    for (const argv of named) {
      expect(argv[0]).toBe("tack");
      yield* parseInvocation(argv.slice(1)).pipe(Effect.provide(BunServices.layer));
    }
  }),
);
