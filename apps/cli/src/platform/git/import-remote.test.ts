import { skillText } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import {
  Effect,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Predicate,
  type Redacted,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner, type CommandLine } from "effect/process";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { makeRemoteFixture } from "../../../test/support/git-remote-fixture.ts";
import {
  classifyGitFailure,
  fixtureRemotesVariable,
  hardenedGitEnvironment,
  ImportRemoteLive,
  makeImportRemote,
  redactGitText,
} from "./import-remote.ts";
import {
  defaultImportLimits,
  ImportRemote,
  allowedProtocolsFor,
  mebibyte,
  productionProtocols,
} from "../../services/import-remote.ts";
import { type RemoteTarget } from "../../domain/imports/remote-target.ts";
import { githubProvider } from "../../domain/imports/providers/github.ts";

/** The GitHub target of the fixture repository `acme/skills`; a fixture root replaces its URL. */
const target: RemoteTarget = githubProvider.remote({
  repository: "acme/skills",
  transport: "https",
});

type RemoteOptions = Parameters<typeof makeImportRemote>[3];

const remoteOver = Effect.fnUntraced(function* (
  options: (root: string) => RemoteOptions = (root) => ({ fixtureRoot: root }),
  limits = defaultImportLimits,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-import-remote-" }),
  );
  return {
    root,
    path,
    fileSystem,
    remote: makeImportRemote(spawner, fileSystem, path, { ...options(root), limits }),
  };
});

/**
 * A spawner that answers the git calls `rewrite` selects with a shell script instead, keeping the
 * call's working directory, environment and input; every other call runs git as usual.
 */
const rewriting = Effect.fnUntraced(function* (
  rewrite: (args: ReadonlyArray<CommandLine.Word>) => string | undefined,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Expected a standard command.");
    const script = rewrite(command.args);
    return spawner.spawn(
      script === undefined
        ? command
        : ChildProcess.make("/bin/sh", ["-c", script], command.options),
    );
  });
});

/** A remote whose git calls go through `spawner`, over fixture repositories under a fresh root. */
const remoteWith = Effect.fnUntraced(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  limits = defaultImportLimits,
  fileSystemOverrides: Partial<FileSystem.FileSystem> = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-import-remote-" }),
  );
  return {
    root,
    remote: makeImportRemote(spawner, { ...fileSystem, ...fileSystemOverrides }, path, {
      fixtureRoot: root,
      limits,
    }),
  };
});

const injected = (method: string) => PlatformError.badArgument({ module: "test", method });

it.layer(LiveTestLayer)("import remote over real git", (remoteIt) => {
  remoteIt.effect("lists the default branch, branches and tags with peeled commits", () =>
    Effect.gen(function* () {
      const { root, remote } = yield* remoteOver();
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        { files: { "skills/pdf/SKILL.md": skillText("pdf") }, tag: "v1.0.0", annotated: true },
        { files: { "skills/docx/SKILL.md": skillText("docx") }, branch: "feature/install" },
        { files: { "skills/pdf/notes.md": "more\n" }, branch: "main", tag: "v2.0.0" },
      ]);
      const refs = yield* remote.listRefs(target);
      expect(refs.headBranch).toBe("main");
      expect(refs.headCommit).toBe(fixture.revisions[2]);
      expect([...refs.branches.keys()].sort()).toEqual(["feature/install", "main"]);
      expect(refs.branches.get("feature/install")).toBe(fixture.revisions[1]);
      // The annotated tag points at its commit, not at the tag object.
      expect(refs.tags.get("v1.0.0")).toBe(fixture.revisions[0]);
      expect(refs.tags.get("v2.0.0")).toBe(fixture.revisions[2]);
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("fetches a commit by full ID, lists its tree and reads exact bytes", () =>
    Effect.gen(function* () {
      const { root, remote } = yield* remoteOver();
      const crlf = new TextEncoder().encode("line one\nline two\nÿ\u0000binary");
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        {
          files: {
            ".gitattributes": "* text eol=crlf\n",
            "skills/pdf/SKILL.md": skillText("pdf"),
            "skills/pdf/data.bin": crlf,
            "skills/pdf/run.sh": { content: "#!/bin/sh\n", executable: true },
            "skills/other/SKILL.md": skillText("other"),
          },
        },
        { files: { "skills/pdf/later.md": "later\n" } },
      ]);
      const first = fixture.revisions[0] ?? "";
      const session = yield* remote.open(target, first);
      const tree = yield* session.list(["skills"]);
      expect(tree.map((entry) => `${entry.mode} ${entry.type} ${entry.path}`)).toEqual([
        "040000 tree skills",
        "040000 tree skills/other",
        "100644 blob skills/other/SKILL.md",
        "040000 tree skills/pdf",
        "100644 blob skills/pdf/SKILL.md",
        "100644 blob skills/pdf/data.bin",
        "100755 blob skills/pdf/run.sh",
      ]);
      expect(tree.some((entry) => entry.path.endsWith("later.md"))).toBe(false);
      yield* session.prefetch(["skills/pdf"]);
      const binary = tree.find((entry) => entry.path === "skills/pdf/data.bin");
      const sizes = yield* session.sizes([binary?.oid ?? ""]);
      expect(sizes.get(binary?.oid ?? "")).toBe(crlf.length);
      const contents = yield* session.read([binary?.oid ?? ""]);
      expect([...(contents.get(binary?.oid ?? "") ?? [])]).toEqual([...crlf]);
      const ids = yield* session.treeIds(["skills/pdf", "skills/missing"]);
      expect(ids.get("skills/pdf")).toBe(tree.find((entry) => entry.path === "skills/pdf")?.oid);
      expect(ids.has("skills/missing")).toBe(false);
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("removes its scratch area when the scope closes", () =>
    Effect.gen(function* () {
      const { root, remote, fileSystem, path } = yield* remoteOver();
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        { files: { "skills/pdf/SKILL.md": skillText("pdf") } },
      ]);
      const temporary = path.join(root, "tmp");
      yield* fileSystem.makeDirectory(temporary, { recursive: true });
      vi.stubEnv("TMPDIR", temporary);
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* remote.open(target, fixture.revisions[0] ?? "");
            yield* session.list([]);
            expect((yield* fileSystem.readDirectory(temporary)).length).toBe(1);
          }),
        );
      } finally {
        vi.unstubAllEnvs();
      }
      expect(yield* fileSystem.readDirectory(temporary)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("lists symlinks and submodules as such, and fetches neither", () =>
    Effect.gen(function* () {
      const { root, remote } = yield* remoteOver();
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        {
          files: {
            "skills/pdf/SKILL.md": skillText("pdf"),
            "skills/pdf/passwd": { symlink: "../../../../../../etc/passwd" },
            "skills/pdf/vendor": { submodule: "1234567890123456789012345678901234567890" },
          },
        },
      ]);
      const session = yield* remote.open(target, fixture.revisions[0] ?? "");
      const tree = yield* session.list(["skills"]);
      expect(tree.find((entry) => entry.path.endsWith("passwd"))).toMatchObject({
        mode: "120000",
        type: "blob",
      });
      expect(tree.find((entry) => entry.path.endsWith("vendor"))).toMatchObject({
        mode: "160000",
        type: "commit",
      });
      yield* session.prefetch(["skills/pdf"]);
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("ignores hooks and filters from the operator's git configuration", () =>
    Effect.gen(function* () {
      const { root, remote, fileSystem, path } = yield* remoteOver();
      const marker = path.join(root, "hook-ran");
      const hooks = path.join(root, "hooks");
      yield* fileSystem.makeDirectory(hooks, { recursive: true });
      for (const hook of ["post-checkout", "post-merge", "reference-transaction"]) {
        yield* fileSystem.writeFileString(path.join(hooks, hook), `#!/bin/sh\ntouch ${marker}\n`);
        yield* fileSystem.chmod(path.join(hooks, hook), 0o755);
      }
      const smudge = path.join(root, "smudge.sh");
      yield* fileSystem.writeFileString(smudge, `#!/bin/sh\ntouch ${marker}\ncat\n`);
      yield* fileSystem.chmod(smudge, 0o755);
      const globalConfig = path.join(root, "gitconfig");
      yield* fileSystem.writeFileString(
        globalConfig,
        `[core]\n\thooksPath = ${hooks}\n[filter "lfs"]\n\tsmudge = ${smudge}\n\trequired = true\n[filter "evil"]\n\tsmudge = ${smudge}\n`,
      );
      const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n";
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        {
          files: {
            ".gitattributes": "* filter=lfs\n*.md filter=evil\n",
            "skills/pdf/SKILL.md": skillText("pdf"),
            "skills/pdf/big.bin": pointer,
          },
        },
      ]);
      vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
      try {
        const session = yield* remote.open(target, fixture.revisions[0] ?? "");
        const tree = yield* session.list(["skills"]);
        yield* session.prefetch(["skills/pdf"]);
        const entry = tree.find((candidate) => candidate.path === "skills/pdf/big.bin");
        const contents = yield* session.read([entry?.oid ?? ""]);
        expect(new TextDecoder().decode(contents.get(entry?.oid ?? ""))).toBe(pointer);
      } finally {
        vi.unstubAllEnvs();
      }
      expect(yield* fileSystem.exists(marker)).toBe(false);
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("refuses a file transport under the production allowlist", () =>
    Effect.gen(function* () {
      const { root, remote } = yield* remoteOver(() => ({}));
      yield* makeRemoteFixture(root, "acme", "skills", [
        { files: { "skills/pdf/SKILL.md": skillText("pdf") } },
      ]);
      const fileTarget = { ...target, url: `file://${root}/acme/skills.git`, protocols: ["file"] };
      const failure = yield* remote.listRefs(fileTarget).pipe(Effect.flip);
      expect(failure.code).toBe("import-fetch-failed");
      expect(failure.message).toMatch(/https and ssh/);
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("gives git only https and ssh when an adapter asks for more, in a release", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const environments: Array<string | Redacted.Redacted | undefined> = [];
      const recording = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command))
          return Effect.die("Expected a standard command.");
        environments.push(command.options.env?.["GIT_ALLOW_PROTOCOL"]);
        return spawner.spawn(command);
      });
      // No fixture root and no widened ceiling: what a compiled release runs with.
      const release = makeImportRemote(recording, fileSystem, path, {});
      const greedy = {
        ...target,
        protocols: ["file", "ext"],
        url: "file:///nowhere/acme/skills.git",
      };
      const failure = yield* release.listRefs(greedy).pipe(Effect.flip);
      expect(failure.code).toBe("import-fetch-failed");
      expect(environments.length).toBeGreaterThan(1);
      expect(new Set(environments)).toEqual(new Set(["https:ssh"]));
      environments.length = 0;
      yield* release
        .listRefs({ ...greedy, protocols: ["ext", "ssh", "file", "https"] })
        .pipe(Effect.flip);
      expect(new Set(environments)).toEqual(new Set(["https:ssh"]));
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("refuses a revision that is not a full commit ID", () =>
    Effect.gen(function* () {
      const { root, remote } = yield* remoteOver();
      yield* makeRemoteFixture(root, "acme", "skills", [{ files: { "a.md": "a\n" } }]);
      for (const revision of ["main", "--upload-pack=evil", "abc1234", ""]) {
        const failure = yield* Effect.scoped(remote.open(target, revision)).pipe(Effect.flip);
        expect(failure.message).toMatch(/full 40-character commit ID/);
      }
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("reports an unknown commit as unavailable", () =>
    Effect.gen(function* () {
      const { root, remote } = yield* remoteOver();
      yield* makeRemoteFixture(root, "acme", "skills", [{ files: { "a.md": "a\n" } }]);
      const failure = yield* Effect.scoped(remote.open(target, "0".repeat(40))).pipe(Effect.flip);
      expect(failure.code).toBe("import-revision-unavailable");
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("stops a transfer that exceeds the scratch limit", () =>
    Effect.gen(function* () {
      const { root, remote } = yield* remoteOver(undefined, {
        ...defaultImportLimits,
        maxScratchBytes: 256 * 1024,
      });
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        {
          files: {
            "skills/pdf/SKILL.md": skillText("pdf"),
            "skills/pdf/blob.bin": crypto.getRandomValues(new Uint8Array(2 * 1024 * 1024)),
          },
        },
      ]);
      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* remote.open(target, fixture.revisions[0] ?? "");
          yield* session.prefetch(["skills/pdf"]);
        }),
      ).pipe(Effect.flip);
      expect(failure.code).toBe("import-limit-exceeded");
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("fails fast and non-interactively when the remote asks for credentials", () =>
    Effect.gen(function* () {
      const server = Bun.serve({
        port: 0,
        fetch: () =>
          new Response("denied", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="private"' },
          }),
      });
      try {
        const { remote } = yield* remoteOver(() => ({
          protocolCeiling: ["http", ...productionProtocols],
        }));
        const started = Date.now();
        const failure = yield* remote
          .listRefs({
            ...target,
            url: `http://127.0.0.1:${server.port}/acme/skills.git`,
            protocols: ["http"],
          })
          .pipe(Effect.flip);
        expect(failure.code).toBe("import-auth-failed");
        expect(failure.message).toMatch(/gh auth setup-git/);
        expect(failure.message).toMatch(/git@github\.com:owner\/repo\.git/);
        expect(failure.message).toMatch(/not found/);
        expect(Date.now() - started).toBeLessThan(15_000);
      } finally {
        yield* Effect.promise(() => server.stop(true));
      }
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("classifies an unreachable remote as a network failure", () =>
    Effect.gen(function* () {
      const { remote } = yield* remoteOver(() => ({
        protocolCeiling: ["http", ...productionProtocols],
      }));
      const failure = yield* remote
        .listRefs({ ...target, url: "http://127.0.0.1:1/acme/skills.git", protocols: ["http"] })
        .pipe(Effect.flip);
      expect(failure.code).toBe("import-network-failed");
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("runs only git, always through the same hardened environment", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-import-spawn-" }),
      );
      const commands: Array<{
        readonly command: string;
        readonly args: ReadonlyArray<CommandLine.Word>;
        readonly env: Readonly<Record<string, string | Redacted.Redacted | undefined>>;
      }> = [];
      const recording = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command))
          return Effect.die("Expected a standard command.");
        commands.push({
          command: command.command,
          args: command.args,
          env: command.options.env ?? {},
        });
        return spawner.spawn(command);
      });
      const remote = makeImportRemote(recording, fileSystem, path, { fixtureRoot: root });
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        { files: { "skills/pdf/SKILL.md": skillText("pdf") } },
      ]);
      yield* remote.listRefs(target);
      const session = yield* remote.open(target, fixture.revisions[0] ?? "");
      yield* session.list(["skills"]);
      yield* session.prefetch(["skills/pdf"]);
      expect(commands.length).toBeGreaterThan(5);
      expect(new Set(commands.map((entry) => entry.command))).toEqual(new Set(["git"]));
      for (const entry of commands) {
        expect(entry.args).toEqual(
          expect.arrayContaining([
            "core.hooksPath=/dev/null",
            "submodule.recurse=false",
            "filter.lfs.smudge=",
          ]),
        );
        expect(entry.env["GIT_TERMINAL_PROMPT"]).toBe("0");
        expect(entry.env["GIT_ALLOW_PROTOCOL"]).toBe("file:https:ssh");
        expect(entry.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
      }
      const fetches = commands.filter((entry) => entry.args.includes("fetch"));
      expect(fetches).toHaveLength(1);
      expect(fetches[0]?.args).toEqual(
        expect.arrayContaining(["--depth=1", "--filter=blob:none", "--no-recurse-submodules"]),
      );
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("reports git that cannot start, finish or report a usable version", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const unavailable = makeImportRemote(
        ChildProcessSpawner.make(() => Effect.fail(injected("spawn"))),
        fileSystem,
        path,
      );
      expect(yield* Effect.flip(unavailable.probe)).toMatchObject({
        code: "import-git-unavailable",
        message: "Git could not be started. Install git and make sure it is on PATH.",
      });
      const unfinished = makeImportRemote(
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              all: Stream.empty,
              exitCode: Effect.fail(injected("exitCode")),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              pid: ChildProcessSpawner.ProcessId(1),
              stderr: Stream.empty,
              stdin: Sink.drain,
              stdout: Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          ),
        ),
        fileSystem,
        path,
      );
      expect(yield* Effect.flip(unfinished.probe)).toMatchObject({
        code: "import-fetch-failed",
        message: "Git did not finish.",
      });
      for (const [script, expected] of [
        ["echo 'not git'", { code: "import-git-unavailable" }],
        ["echo 'git version 2.40.0'; exit 1", { code: "import-git-unavailable" }],
        [
          "echo 'git version 2.20.1'",
          {
            code: "import-git-too-old",
            message: "Git 2.20 is too old for import. Upgrade git to 2.25 or newer.",
          },
        ],
      ] as const) {
        const { remote } = yield* remoteWith(
          yield* rewriting((args) => (args.includes("--version") ? script : undefined)),
        );
        expect(yield* Effect.flip(remote.probe)).toMatchObject(expected);
      }
      const { remote: future } = yield* remoteWith(
        yield* rewriting((args) =>
          args.includes("--version") ? "echo 'git version 3.0.0'" : undefined,
        ),
      );
      expect(yield* future.probe).toEqual({ version: "3.0" });
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("lists only branch and tag refs and leaves an unnamed head out", () =>
    Effect.gen(function* () {
      const listing = [
        "ref: refs/tags/v1\\tHEAD",
        "ref: refs/heads/other\\tNOT-HEAD",
        "line-without-a-name",
        "1111111111111111111111111111111111111111\\trefs/notes/commits",
        "2222222222222222222222222222222222222222\\trefs/heads/main",
      ].join("\\n");
      const { remote } = yield* remoteWith(
        yield* rewriting((args) =>
          args.includes("ls-remote") ? `printf '${listing}\\n'` : undefined,
        ),
      );
      const refs = yield* remote.listRefs(target);
      expect(refs).toEqual({
        branches: new Map([["main", "2222222222222222222222222222222222222222"]]),
        tags: new Map(),
      });
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("stops a remote that does not answer and a fetch past the command limit", () =>
    Effect.gen(function* () {
      const limits = { ...defaultImportLimits, commandTimeoutMillis: 200 };
      const { remote: silent } = yield* remoteWith(
        yield* rewriting((args) => (args.includes("ls-remote") ? "exec sleep 5" : undefined)),
        limits,
      );
      expect(yield* Effect.flip(silent.listRefs(target))).toMatchObject({
        code: "import-timeout",
        message: "The remote did not answer in time.",
      });
      const { remote: slow } = yield* remoteWith(
        yield* rewriting((args) => (args.includes("fetch") ? "exec sleep 5" : undefined)),
        limits,
      );
      const failure = yield* Effect.scoped(slow.open(target, "0".repeat(40))).pipe(Effect.flip);
      expect(failure).toMatchObject({
        code: "import-timeout",
        message: "The fetch took longer than the command limit and was stopped.",
      });
    }).pipe(
      Effect.scoped,
      // The limits under test are wall-clock timers, so the run uses the live clock.
      TestClock.withLive,
    ),
  );

  remoteIt.effect("stops a transfer that stalls or outgrows the scratch limit while it runs", () =>
    Effect.gen(function* () {
      const { remote: stalled } = yield* remoteWith(
        yield* rewriting((args) => (args.includes("fetch") ? "exec sleep 5" : undefined)),
        { ...defaultImportLimits, idleTimeoutMillis: 0 },
      );
      expect(
        yield* Effect.scoped(stalled.open(target, "0".repeat(40))).pipe(Effect.flip),
      ).toMatchObject({
        code: "import-timeout",
        message: "The transfer made no progress and was stopped.",
      });
      const { remote: growing } = yield* remoteWith(
        yield* rewriting((args) =>
          args.includes("fetch") ? "head -c 400000 /dev/zero > grown.bin; exec sleep 5" : undefined,
        ),
        { ...defaultImportLimits, maxScratchBytes: 256 * 1024 },
      );
      expect(
        yield* Effect.scoped(growing.open(target, "0".repeat(40))).pipe(Effect.flip),
      ).toMatchObject({ code: "import-limit-exceeded" });
    }).pipe(
      Effect.scoped,
      // The limits under test are wall-clock timers, so the run uses the live clock.
      TestClock.withLive,
    ),
  );

  remoteIt.effect("waits for a transfer that pauses for less than the idle limit", () =>
    Effect.gen(function* () {
      // The fetch writes nothing for a second, so the monitor samples the same size several times
      // before the transfer ends, however slowly the machine runs.
      const { remote: pausing } = yield* remoteWith(
        yield* rewriting((args) => (args.includes("fetch") ? "exec sleep 1" : undefined)),
      );
      const session = yield* Effect.scoped(pausing.open(target, "0".repeat(40)));
      expect(session.revision).toBe("0".repeat(40));
    }).pipe(
      Effect.scoped,
      // The idle limit under test is a wall-clock timer, so the run uses the live clock.
      TestClock.withLive,
    ),
  );

  remoteIt.effect("reports a scratch directory it cannot create or prepare", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const [overrides, message] of [
        [
          { makeTempDirectoryScoped: () => Effect.fail(injected("makeTempDirectoryScoped")) },
          "Tack could not create a scratch directory.",
        ],
        [
          { writeFileString: () => Effect.fail(injected("writeFileString")) },
          "Tack could not prepare the scratch directory.",
        ],
      ] as const) {
        const { remote } = yield* remoteWith(spawner, defaultImportLimits, overrides);
        const failure = yield* Effect.scoped(remote.open(target, "0".repeat(40))).pipe(Effect.flip);
        expect(failure).toMatchObject({ code: "import-fetch-failed", message });
      }
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("refuses a listing larger than the tree entry limit", () =>
    Effect.gen(function* () {
      const { root, remote } = yield* remoteOver(undefined, {
        ...defaultImportLimits,
        maxTreeEntries: 2,
      });
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        { files: { "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" } },
      ]);
      const session = yield* remote.open(target, fixture.revisions[0] ?? "");
      expect(yield* Effect.flip(session.list([]))).toMatchObject({
        code: "import-limit-exceeded",
        message: "The repository listing has more than 2 entries. Scope the location to a folder.",
      });
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("checks out nothing, the whole tree, or exactly the named folders", () =>
    Effect.gen(function* () {
      const { root, remote, fileSystem, path } = yield* remoteOver();
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        {
          files: {
            "skills/with space/SKILL.md": skillText("spaced"),
            "skills/star*/SKILL.md": skillText("star"),
            "skills/other/SKILL.md": skillText("other"),
          },
        },
      ]);
      const checkedOut = (directories: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const temporary = path.join(root, `tmp-${crypto.randomUUID()}`);
          yield* fileSystem.makeDirectory(temporary, { recursive: true });
          vi.stubEnv("TMPDIR", temporary);
          try {
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const session = yield* remote.open(target, fixture.revisions[0] ?? "");
                yield* session.prefetch(directories);
                const [scratch] = yield* fileSystem.readDirectory(temporary);
                const skills = path.join(temporary, scratch ?? "", "skills");
                return (yield* fileSystem.exists(skills))
                  ? (yield* fileSystem.readDirectory(skills)).sort()
                  : [];
              }),
            );
          } finally {
            vi.unstubAllEnvs();
          }
        });

      expect(yield* checkedOut([])).toEqual([]);
      expect(yield* checkedOut([""])).toEqual(["other", "star*", "with space"]);
      expect(yield* checkedOut(["skills/with space", "skills/star*"])).toEqual([
        "star*",
        "with space",
      ]);
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("answers empty requests without git and refuses an object that is no file", () =>
    Effect.gen(function* () {
      const { root, remote } = yield* remoteOver();
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        { files: { "skills/pdf/SKILL.md": skillText("pdf") } },
      ]);
      const session = yield* remote.open(target, fixture.revisions[0] ?? "");
      expect(yield* session.sizes([])).toEqual(new Map());
      expect(yield* session.read([])).toEqual(new Map());
      expect(yield* session.treeIds([])).toEqual(new Map());
      const tree = yield* session.list(["skills"]);
      const folder = tree.find((entry) => entry.path === "skills/pdf");
      expect(yield* Effect.flip(session.read([folder?.oid ?? ""]))).toMatchObject({
        code: "import-fetch-failed",
        message: "Git returned an unexpected object.",
      });
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("reports git that closes its input unread as a failed run", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Git closes its input and exits without reading it; the object list reaches the pipe after
      // the close, so writing it breaks the pipe every time instead of on a lucky schedule.
      const closing = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command))
          return Effect.die("Expected a standard command.");
        const input = command.options.stdin;
        const batchCheck = command.args.some(
          (arg) => Predicate.isString(arg) && arg.startsWith("--batch-check"),
        );
        if (!batchCheck || !Stream.isStream(input)) return spawner.spawn(command);
        const closed = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
        return spawner.spawn(
          ChildProcess.make("/bin/sh", ["-c", "exec 0<&-; sleep 0.5; exit 128"], {
            ...command.options,
            stdin: Stream.fromEffectDrain(closed).pipe(Stream.concat(input)),
          }),
        );
      });
      const { root, remote } = yield* remoteWith(closing);
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        { files: { "a.md": "a\n" } },
      ]);
      const session = yield* remote.open(target, fixture.revisions[0] ?? "");
      expect(yield* Effect.flip(session.sizes(["1".repeat(40)]))).toMatchObject({
        code: "import-fetch-failed",
      });
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("reads nothing from an object answer without a header line", () =>
    Effect.gen(function* () {
      const { root, remote } = yield* remoteWith(
        yield* rewriting((args) => (args.includes("--batch") ? "printf 'truncated'" : undefined)),
      );
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        { files: { "a.md": "a\n" } },
      ]);
      const session = yield* remote.open(target, fixture.revisions[0] ?? "");
      expect(yield* session.read(["1".repeat(40)])).toEqual(new Map());
    }).pipe(Effect.scoped),
  );

  remoteIt.effect("points the production remote at fixture repositories in source runs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-import-live-" }),
      );
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        { files: { "a.md": "a\n" } },
      ]);
      vi.stubEnv(fixtureRemotesVariable, root);
      try {
        const refs = yield* Effect.gen(function* () {
          return yield* (yield* ImportRemote).listRefs(target);
        }).pipe(Effect.provide(Layer.fresh(ImportRemoteLive)));
        expect(refs.headCommit).toBe(fixture.revisions[0]);
      } finally {
        vi.unstubAllEnvs();
      }
    }).pipe(Effect.scoped),
  );
});

it("defaults to 2,000 files and 50 MiB per skill, 5 MiB per file and 100 MiB per import", () => {
  expect(defaultImportLimits).toMatchObject({
    maxFilesPerSkill: 2000,
    maxBytesPerSkill: 50 * mebibyte,
    maxFileBytes: 5 * mebibyte,
    maxBytesPerImport: 100 * mebibyte,
  });
});

it("uses an environment that allows only https and ssh and never prompts", () => {
  const environment = hardenedGitEnvironment(
    allowedProtocolsFor(["https", "ssh"], productionProtocols),
    {},
  );
  expect(environment["GIT_ALLOW_PROTOCOL"]).toBe("https:ssh");
  expect(environment["GIT_TERMINAL_PROMPT"]).toBe("0");
  expect(environment["GIT_SSH_COMMAND"]).toContain("BatchMode=yes");
});

it("never allows a protocol outside the ceiling, whatever is requested", () => {
  expect(allowedProtocolsFor(["https", "ssh"], productionProtocols)).toBe("https:ssh");
  expect(allowedProtocolsFor(["ssh"], productionProtocols)).toBe("ssh");
  expect(allowedProtocolsFor(["https", "file", "ext"], productionProtocols)).toBe("https");
  expect(allowedProtocolsFor(["file", "ext"], productionProtocols)).toBe("https:ssh");
  expect(allowedProtocolsFor([], productionProtocols)).toBe("https:ssh");
  expect(allowedProtocolsFor(["file", "https"], ["file", "https", "ssh"])).toBe("file:https");
});

it("classifies git failures into one authentication class and never exposes credentials", () => {
  for (const stderr of [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
    "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    "fatal: Authentication failed for 'https://user:hunter2@github.com/o/r.git/'",
  ]) {
    const error = classifyGitFailure(stderr, target.authenticationHelp);
    expect(error.code).toBe("import-auth-failed");
    expect(error.message).not.toContain("hunter2");
  }
  expect(
    classifyGitFailure(
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      target.authenticationHelp,
    ).code,
  ).toBe("import-network-failed");
  expect(
    classifyGitFailure("fatal: couldn't find remote ref 1a2c79d", target.authenticationHelp).code,
  ).toBe("import-revision-unavailable");
  expect(redactGitText("clone https://user:hunter2@github.com/x\u001b[31m")).toBe(
    "clone https://github.com/x[31m",
  );
});

it("reports an unrecognized git failure with the last lines it printed, without credentials", () => {
  expect(
    classifyGitFailure(
      "warning: one\nfatal: something odd at https://user:hunter2@example.com/x\ndetail\n",
      target.authenticationHelp,
    ),
  ).toMatchObject({
    code: "import-fetch-failed",
    message: "Git failed: fatal: something odd at https://example.com/x detail",
  });
  expect(classifyGitFailure("  \n", target.authenticationHelp)).toMatchObject({
    code: "import-fetch-failed",
    message: "Git failed.",
  });
});
