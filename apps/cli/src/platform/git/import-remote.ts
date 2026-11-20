import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compiledRelease } from "../../release.ts";
import {
  ImportFetchError,
  ImportRemote,
  allowedProtocolsFor,
  defaultImportLimits,
  mebibyte,
  productionProtocols,
  type FetchSession,
  type ImportLimits,
  type ImportRemoteService,
  type RefListing,
  type TreeEntry,
} from "../../services/import-remote.ts";
import { type RemoteTarget } from "../../domain/imports/remote-target.ts";

const credentialPattern = /(\w+:\/\/)[^/@\s]*@/g;

/** Removes credentials and control characters from text that may reach output. */
export const redactGitText = (text: string): string =>
  text
    .replace(credentialPattern, "$1")
    // oxlint-disable-next-line eslint/no-control-regex -- Terminal control characters are removed.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** Maps what git printed to one failure class. No raw output is exposed for authentication. */
export const classifyGitFailure = (
  stderr: string,
  authenticationHelp: string,
): ImportFetchError => {
  const text = stderr.toLowerCase();
  if (
    /could not read (username|password)|authentication failed|terminal prompts disabled|permission denied \(publickey|repository not found|returned error: 40[13]|invalid username or password|host key verification failed|could not read from remote repository|access denied|requested url returned error: 40[13]|publickey|fatal: unable to access .*: the requested url returned error: 404/.test(
      text,
    ) &&
    !/could not resolve host|connection (refused|timed out)|network is unreachable/.test(text)
  )
    return new ImportFetchError({
      code: "import-auth-failed",
      message: `Git could not read the repository without credentials, or it does not exist. ${authenticationHelp}`,
    });
  if (
    /could not resolve host|connection (refused|timed out|reset)|network is unreachable|failed to connect|operation timed out|unable to access|ssl|early eof|the remote end hung up|temporary failure in name resolution/.test(
      text,
    )
  )
    return new ImportFetchError({
      code: "import-network-failed",
      message:
        "Git could not reach the remote. Check the network connection and try again; nothing was changed.",
    });
  if (/not allowed|transport .* not allowed|protocol .* is not allowed/.test(text))
    return new ImportFetchError({
      code: "import-fetch-failed",
      message:
        "Git refused a transport that Tack does not allow. Only https and ssh remotes are used.",
    });
  if (/couldn't find remote ref|not our ref|no such remote ref|unadvertised object/.test(text))
    return new ImportFetchError({
      code: "import-revision-unavailable",
      message:
        "The remote no longer serves this commit. It may have been rewritten upstream; the imported snapshot is unaffected.",
    });
  const excerpt = redactGitText(stderr).trim().split("\n").slice(-2).join(" ").slice(0, 240);
  return new ImportFetchError({
    code: "import-fetch-failed",
    message: `Git failed${excerpt.length === 0 ? "." : `: ${excerpt}`}`,
  });
};

/** The environment every git process runs with: no prompts, no system config, no tracing. */
export const hardenedGitEnvironment = (
  allowedProtocols: string,
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => ({
  GIT_ALLOW_PROTOCOL: allowedProtocols,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  SSH_ASKPASS: "true",
  SSH_ASKPASS_REQUIRE: "never",
  GCM_INTERACTIVE: "never",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_SSH_COMMAND: `${inherited["GIT_SSH_COMMAND"] ?? "ssh"} -o BatchMode=yes -o ConnectTimeout=20`,
  // Nothing that could print a credential, and nothing that redirects git elsewhere.
  GIT_TRACE: undefined,
  GIT_TRACE_CURL: undefined,
  GIT_TRACE_PACKET: undefined,
  GIT_CURL_VERBOSE: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_NAMESPACE: undefined,
  GIT_EXTERNAL_DIFF: undefined,
  GIT_CONFIG_COUNT: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
  GIT_REPLACE_REF_BASE: undefined,
  GIT_NO_REPLACE_OBJECTS: "1",
});

/** Configuration passed to every git call: no hooks, no filters, no submodules, exact bytes. */
const hardenedGitConfiguration: ReadonlyArray<string> = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.symlinks=false",
  "core.autocrlf=false",
  "core.safecrlf=false",
  "core.untrackedCache=false",
  "protocol.version=2",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
  "gc.auto=0",
  "maintenance.auto=false",
  "advice.detachedHead=false",
  "filter.lfs.smudge=",
  "filter.lfs.process=",
  "filter.lfs.required=false",
].flatMap((setting) => ["-c", setting]);

type GitRun = {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
};

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const parseVersion = (output: string) => /git version (\d+)\.(\d+)/.exec(output);

const directoryBytes = (directory: string): number => {
  let total = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: ReadonlyArray<import("node:fs").Dirent>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else {
        try {
          total += lstatSync(target).size;
        } catch {
          // A file git removed between listing and stat counts as nothing.
        }
      }
    }
  }
  return total;
};

/** Builds the git-backed remote over an injectable process spawner. */
export const makeImportRemote = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  options: {
    readonly limits?: ImportLimits;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    /**
     * A directory of local bare repositories, `<root>/<fixturePath>.git`, that replaces every
     * target's URL. Source runs of tests only: a compiled release never passes it.
     */
    readonly fixtureRoot?: string;
    /** The protocols git may ever use. Tests widen it; the default is production's. */
    readonly protocolCeiling?: ReadonlyArray<string>;
  } = {},
): ImportRemoteService => {
  const limits = options.limits ?? defaultImportLimits;
  const ceiling =
    options.protocolCeiling ??
    (options.fixtureRoot === undefined ? productionProtocols : ["file", ...productionProtocols]);
  const inherited = options.environment ?? process.env;
  const environmentFor = (requested: ReadonlyArray<string>) =>
    hardenedGitEnvironment(allowedProtocolsFor(requested, ceiling), inherited);

  /** The URL git is given and the protocols asked for it: a fixture replaces both. */
  const reach = (target: RemoteTarget) =>
    options.fixtureRoot === undefined
      ? { url: target.url, protocols: target.protocols }
      : {
          url: `file://${path.join(options.fixtureRoot, `${target.fixturePath}.git`)}`,
          protocols: ["file", ...target.protocols],
        };

  const spawnFailure = (message: string) =>
    new ImportFetchError({ code: "import-git-unavailable", message });

  const run = (
    args: ReadonlyArray<string>,
    config: {
      readonly cwd?: string;
      readonly stdin?: Uint8Array;
      readonly protocols?: ReadonlyArray<string>;
    },
  ): Effect.Effect<GitRun, ImportFetchError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make("git", [...hardenedGitConfiguration, ...args], {
              ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
              env: environmentFor(config.protocols ?? ceiling),
              extendEnv: true,
              ...(config.stdin === undefined
                ? { stdin: "ignore" as const }
                : { stdin: Stream.make(config.stdin) }),
            }),
          )
          .pipe(
            Effect.mapError(() =>
              spawnFailure("Git could not be started. Install git and make sure it is on PATH."),
            ),
          );
        const output = yield* Effect.all(
          {
            stdout: handle.stdout.pipe(Stream.mkUint8Array),
            stderr: handle.stderr.pipe(Stream.decodeText, Stream.mkString),
            exitCode: handle.exitCode,
          },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            () =>
              new ImportFetchError({
                code: "import-fetch-failed",
                message: "Git did not finish.",
              }),
          ),
        );
        return { stdout: output.stdout, stderr: output.stderr, exitCode: Number(output.exitCode) };
      }),
    );

  const succeeding =
    (authenticationHelp: string) =>
    (result: GitRun): Effect.Effect<Uint8Array, ImportFetchError> =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(classifyGitFailure(result.stderr, authenticationHelp));

  const guarded = <A>(
    effect: Effect.Effect<A, ImportFetchError>,
    scratch: string,
  ): Effect.Effect<A, ImportFetchError> => {
    const monitor = Effect.gen(function* () {
      let last = -1;
      let idleSince = Date.now();
      while (true) {
        yield* Effect.sleep("250 millis");
        const bytes = yield* Effect.sync(() => directoryBytes(scratch));
        if (bytes > limits.maxScratchBytes)
          return yield* new ImportFetchError({
            code: "import-limit-exceeded",
            message: `The transfer exceeded the ${Math.floor(limits.maxScratchBytes / mebibyte)} MiB scratch limit and was stopped.`,
          });
        if (bytes !== last) {
          last = bytes;
          idleSince = Date.now();
        } else if (Date.now() - idleSince > limits.idleTimeoutMillis)
          return yield* new ImportFetchError({
            code: "import-timeout",
            message: "The transfer made no progress and was stopped.",
          });
      }
    });
    const finalCheck = Effect.sync(() => directoryBytes(scratch)).pipe(
      Effect.flatMap((bytes) =>
        bytes > limits.maxScratchBytes
          ? Effect.fail(
              new ImportFetchError({
                code: "import-limit-exceeded",
                message: `The transfer exceeded the ${Math.floor(limits.maxScratchBytes / mebibyte)} MiB scratch limit and was stopped.`,
              }),
            )
          : Effect.void,
      ),
    );
    return Effect.raceFirst(effect, monitor).pipe(Effect.tap(() => finalCheck));
  };

  const probe = run(["--version"], {}).pipe(
    Effect.flatMap((result) => {
      const match = parseVersion(textDecoder.decode(result.stdout));
      if (result.exitCode !== 0 || match === null)
        return Effect.fail(spawnFailure("Git could not report its version."));
      const major = Number(match[1]);
      const minor = Number(match[2]);
      return major > 2 || (major === 2 && minor >= 25)
        ? Effect.succeed({ version: `${major}.${minor}` })
        : Effect.fail(
            new ImportFetchError({
              code: "import-git-too-old",
              message: `Git ${major}.${minor} is too old for import. Upgrade git to 2.25 or newer.`,
            }),
          );
    }),
  );

  const parseRefs = (output: string): RefListing => {
    const branches = new Map<string, string>();
    const tags = new Map<string, string>();
    const peeled = new Map<string, string>();
    let headBranch: string | undefined;
    let headCommit: string | undefined;
    for (const line of output.split("\n")) {
      if (line.length === 0) continue;
      if (line.startsWith("ref: ")) {
        const [target, name] = line.slice(5).split("\t");
        if (name === "HEAD" && target?.startsWith("refs/heads/") === true)
          headBranch = target.slice("refs/heads/".length);
        continue;
      }
      const [oid, name] = line.split("\t");
      if (oid === undefined || name === undefined) continue;
      if (name === "HEAD") headCommit = oid;
      else if (name.startsWith("refs/heads/")) branches.set(name.slice("refs/heads/".length), oid);
      else if (name.startsWith("refs/tags/")) {
        const tag = name.slice("refs/tags/".length);
        if (tag.endsWith("^{}")) peeled.set(tag.slice(0, -3), oid);
        else tags.set(tag, oid);
      }
    }
    for (const [tag, commit] of peeled) tags.set(tag, commit);
    return {
      ...(headBranch === undefined ? {} : { headBranch }),
      ...(headCommit === undefined ? {} : { headCommit }),
      branches,
      tags,
    };
  };

  const listRefs = (target: RemoteTarget) =>
    Effect.gen(function* () {
      yield* probe;
      const succeed = succeeding(target.authenticationHelp);
      const where = reach(target);
      const result = yield* run(
        ["ls-remote", "--symref", "--", where.url, "HEAD", "refs/heads/*", "refs/tags/*"],
        { protocols: where.protocols },
      ).pipe(
        Effect.timeoutOrElse({
          duration: limits.commandTimeoutMillis,
          orElse: () =>
            Effect.fail(
              new ImportFetchError({
                code: "import-timeout",
                message: "The remote did not answer in time.",
              }),
            ),
        }),
      );
      return parseRefs(textDecoder.decode(yield* succeed(result)));
    });

  const parseTree = (output: Uint8Array): ReadonlyArray<TreeEntry> => {
    const entries: TreeEntry[] = [];
    for (const record of textDecoder.decode(output).split("\0")) {
      if (record.length === 0) continue;
      const tab = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      if (
        mode === undefined ||
        oid === undefined ||
        (type !== "blob" && type !== "tree" && type !== "commit")
      )
        continue;
      entries.push({ mode, type, oid, path: record.slice(tab + 1) });
    }
    return entries;
  };

  const open = (target: RemoteTarget, revision: string) =>
    Effect.gen(function* () {
      if (!/^[0-9a-f]{40}$/.test(revision))
        return yield* new ImportFetchError({
          code: "import-fetch-failed",
          message: "A revision must be a full 40-character commit ID.",
        });
      yield* probe;
      const scratch = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-import-" }).pipe(
        Effect.mapError(
          () =>
            new ImportFetchError({
              code: "import-fetch-failed",
              message: "Tack could not create a scratch directory.",
            }),
        ),
      );
      const succeed = succeeding(target.authenticationHelp);
      const where = reach(target);
      const git = (args: ReadonlyArray<string>, stdin?: Uint8Array) =>
        run(args, {
          cwd: scratch,
          protocols: where.protocols,
          ...(stdin === undefined ? {} : { stdin }),
        });
      yield* git(["init", "--quiet"]).pipe(Effect.flatMap(succeed));
      // The highest-precedence attributes: nothing from the repository can pick a filter, an
      // identity expansion, an encoding or a line-ending conversion for the files git writes.
      yield* fileSystem
        .writeFileString(
          path.join(scratch, ".git", "info", "attributes"),
          "* !filter !ident !working-tree-encoding -text\n",
        )
        .pipe(
          Effect.mapError(
            () =>
              new ImportFetchError({
                code: "import-fetch-failed",
                message: "Tack could not prepare the scratch directory.",
              }),
          ),
        );
      yield* git(["remote", "add", "origin", where.url]).pipe(Effect.flatMap(succeed));
      yield* guarded(
        git([
          "fetch",
          "--quiet",
          "--depth=1",
          "--filter=blob:none",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-write-fetch-head",
          "origin",
          revision,
        ]).pipe(Effect.flatMap(succeed)),
        scratch,
      ).pipe(
        Effect.timeoutOrElse({
          duration: limits.commandTimeoutMillis,
          orElse: () =>
            Effect.fail(
              new ImportFetchError({
                code: "import-timeout",
                message: "The fetch took longer than the command limit and was stopped.",
              }),
            ),
        }),
      );
      const objectLines = (values: ReadonlyArray<string>) =>
        textEncoder.encode(`${values.join("\n")}\n`);
      const session: FetchSession = {
        revision,
        list: (pathspecs) =>
          git([
            "ls-tree",
            "-r",
            "-t",
            "-z",
            revision,
            ...(pathspecs.length === 0 ? [] : ["--", ...pathspecs]),
          ]).pipe(
            Effect.flatMap(succeed),
            Effect.flatMap((output) => {
              const entries = parseTree(output);
              return entries.length > limits.maxTreeEntries
                ? Effect.fail(
                    new ImportFetchError({
                      code: "import-limit-exceeded",
                      message: `The repository listing has more than ${limits.maxTreeEntries} entries. Scope the location to a folder.`,
                    }),
                  )
                : Effect.succeed(entries);
            }),
          ),
        prefetch: (directories) => {
          if (directories.length === 0) return Effect.void;
          // An empty directory is the repository root: everything.
          const escaped = directories.map((directory) =>
            directory.length === 0
              ? "/*"
              : `/${directory.replace(/[\\*?[\]!#\s]/g, (character) => `\\${character}`)}/`,
          );
          return guarded(
            Effect.gen(function* () {
              yield* git(["config", "core.sparseCheckoutCone", "false"]).pipe(
                Effect.flatMap(succeed),
              );
              yield* git(
                ["sparse-checkout", "set", "--no-cone", "--stdin"],
                objectLines(escaped),
              ).pipe(Effect.flatMap(succeed));
              yield* git(["checkout", "--quiet", "--detach", revision]).pipe(
                Effect.flatMap(succeed),
              );
            }),
            scratch,
          );
        },
        sizes: (oids) =>
          oids.length === 0
            ? Effect.succeed(new Map())
            : git(
                ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
                objectLines(oids),
              ).pipe(
                Effect.flatMap(succeed),
                Effect.map((output) => {
                  const sizes = new Map<string, number>();
                  for (const line of textDecoder.decode(output).split("\n")) {
                    const [oid, size] = line.split(" ");
                    if (oid !== undefined && size !== undefined && /^\d+$/.test(size))
                      sizes.set(oid, Number(size));
                  }
                  return sizes;
                }),
              ),
        read: (oids) =>
          oids.length === 0
            ? Effect.succeed(new Map())
            : git(["cat-file", "--batch"], objectLines(oids)).pipe(
                Effect.flatMap(succeed),
                Effect.flatMap((output) => {
                  const contents = new Map<string, Uint8Array>();
                  let offset = 0;
                  while (offset < output.length) {
                    const newline = output.indexOf(10, offset);
                    if (newline === -1) break;
                    const header = textDecoder.decode(output.subarray(offset, newline)).split(" ");
                    const size = Number(header[2]);
                    if (header[1] !== "blob" || !Number.isInteger(size))
                      return Effect.fail(
                        new ImportFetchError({
                          code: "import-fetch-failed",
                          message: "Git returned an unexpected object.",
                        }),
                      );
                    contents.set(header[0] ?? "", output.slice(newline + 1, newline + 1 + size));
                    offset = newline + 1 + size + 1;
                  }
                  return Effect.succeed(contents);
                }),
              ),
        treeIds: (paths) =>
          paths.length === 0
            ? Effect.succeed(new Map())
            : git(
                ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
                objectLines(paths.map((entry) => `${revision}:${entry}`)),
              ).pipe(
                Effect.flatMap(succeed),
                Effect.map((output) => {
                  const ids = new Map<string, string>();
                  const lines = textDecoder.decode(output).split("\n");
                  for (const [index, line] of lines.entries()) {
                    const [oid, type] = line.split(" ");
                    const entry = paths[index];
                    if (entry !== undefined && type === "tree" && oid !== undefined)
                      ids.set(entry, oid);
                  }
                  return ids;
                }),
              ),
      };
      return session;
    });

  return { limits, probe, listRefs, open };
};

/**
 * Environment variable that points the fetch boundary at a directory of local bare repositories,
 * laid out as `<root>/<owner>/<repo>.git`. It exists only for source runs in tests and is ignored
 * by a compiled release, so the product transport allowlist is never widened.
 */
export const fixtureRemotesVariable = "TACK_IMPORT_FIXTURE_REMOTES";

/** The production remote: https and ssh to whatever a provider names, with default limits. */
export const ImportRemoteLive = Layer.effect(
  ImportRemote,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtureRoot = compiledRelease ? undefined : process.env[fixtureRemotesVariable];
    return ImportRemote.of(
      makeImportRemote(spawner, fileSystem, path, {
        ...(fixtureRoot === undefined || fixtureRoot.length === 0 ? {} : { fixtureRoot }),
      }),
    );
  }),
);
