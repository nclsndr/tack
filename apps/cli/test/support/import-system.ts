import { skillText } from "./source-tree.ts";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRemoteFixture, type FixtureCommit } from "./git-remote-fixture.ts";
import { runTackInProcess } from "./host-runner.ts";
import { runTack } from "./tack-process.ts";

/** The result of one Tack process run. */
type TackRun = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** A run whose stdout is one public JSON envelope. */
type TackJson = TackRun & {
  // oxlint-disable-next-line typescript/no-explicit-any -- Test assertions read arbitrary envelope fields.
  readonly envelope: any;
};

/** Extra process settings for one run. */
type RunOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Kill the process after this long, in milliseconds. */
  readonly timeoutMillis?: number;
};

/** One isolated world: a state directory, a home, a destination source and a fixture remote. */
export type SystemWorld = {
  readonly root: string;
  readonly home: string;
  readonly state: string;
  readonly remotes: string;
  /** The destination source root. */
  readonly brain: string;
  readonly revisions: ReadonlyArray<string>;
  readonly run: (args: ReadonlyArray<string>, options?: RunOptions) => Promise<TackRun>;
  readonly json: (args: ReadonlyArray<string>, options?: RunOptions) => Promise<TackJson>;
};

const decodeJson = (run: TackRun): TackJson => ({
  ...run,
  envelope: run.stdout.trim().length === 0 ? undefined : JSON.parse(run.stdout),
});

/**
 * Starts one Tack source process with the world's isolated home and state and its fixture remotes,
 * in the world's root unless told otherwise, and collects its output.
 */
const spawnTack = async (
  world: Pick<SystemWorld, "home" | "state" | "remotes" | "root">,
  args: ReadonlyArray<string>,
  options: RunOptions = {},
): Promise<TackRun> => {
  const { exitCode, stdout, stderr } = await runTack(args, {
    home: world.home,
    state: world.state,
    cwd: options.cwd ?? world.root,
    env: { TACK_IMPORT_FIXTURE_REMOTES: world.remotes, ...options.env },
    ...(options.timeoutMillis === undefined ? {} : { timeoutMillis: options.timeoutMillis }),
  });
  return { code: exitCode, stdout, stderr };
};

/** {@link spawnTack} in the test process; a run that must be killed needs a process. */
const hostTack = async (
  world: Pick<SystemWorld, "home" | "state" | "remotes" | "root">,
  args: ReadonlyArray<string>,
  options: RunOptions = {},
): Promise<TackRun> => {
  if (options.timeoutMillis !== undefined) throw new Error("A run with a timeout needs a process.");
  const { exitCode, stdout, stderr } = await Effect.runPromise(
    runTackInProcess(args, {
      home: world.home,
      state: world.state,
      cwd: options.cwd ?? world.root,
      env: { TACK_IMPORT_FIXTURE_REMOTES: world.remotes, ...options.env },
    }),
  );
  return { code: exitCode, stdout, stderr };
};

/** Runs git against a fixture and requires success. */
export const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
};

/** Creates a git repository with one commit, for registering a project. */
const makeRepository = async (parent: string, name: string): Promise<string> => {
  const directory = join(parent, name);
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(directory, "README.md"), "fixture\n");
  await git(directory, ["add", "README.md"]);
  await git(directory, ["commit", "--quiet", "-m", "init"]);
  return realpath(directory);
};

/**
 * Builds an isolated world: an initialized state, a destination source from the given declaration
 * and files (registered unless told not to), and a fixture remote at `acme/skills`. Temporary
 * directories are left behind on purpose.
 */
export const makeSystemWorld = async (input: {
  readonly declaration?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly commits: ReadonlyArray<FixtureCommit>;
  readonly register?: boolean;
  /**
   * Runs every `tack` in the test process, one at a time, in place of a child process. A test
   * that asserts only envelopes, exit statuses and files sets it; a kill or a held lock needs a
   * process.
   */
  readonly inProcess?: boolean;
}): Promise<SystemWorld> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tack-import-system-")));
  const home = join(root, "home");
  const state = join(root, "state");
  const remotes = join(root, "remotes");
  const brain = join(root, "personal-brain");
  await Promise.all([mkdir(home), mkdir(brain)]);
  await writeFile(
    join(brain, "tack.yaml"),
    input.declaration ?? "version: 1\nname: personal-brain\nskills:\n  - path: skills\n",
  );
  for (const [relative, content] of Object.entries(
    input.files ?? { "skills/mine/SKILL.md": skillText("mine") },
  )) {
    await mkdir(join(brain, relative, ".."), { recursive: true });
    await writeFile(join(brain, relative), content);
  }
  const fixture = await Effect.runPromise(
    makeRemoteFixture(remotes, "acme", "skills", input.commits).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
    ),
  );
  const base = { root, home, state, remotes };
  const run = (args: ReadonlyArray<string>, options?: RunOptions) =>
    input.inProcess === true ? hostTack(base, args, options) : spawnTack(base, args, options);
  const json = async (args: ReadonlyArray<string>, options?: RunOptions) =>
    decodeJson(await run(["--json", ...args], options));
  const initialized = await run(["state", "init"]);
  if (initialized.code !== 0) throw new Error(initialized.stderr);
  if (input.register !== false) {
    const registered = await run(["source", "add", brain]);
    if (registered.code !== 0) throw new Error(registered.stdout + registered.stderr);
  }
  return { ...base, brain, revisions: fixture.revisions, run, json };
};

/** Registers a project backed by a fresh git repository and enables the codex adapter. */
export const addProject = async (world: SystemWorld, name: string): Promise<string> => {
  const repository = await makeRepository(join(world.root, "projects"), name);
  const added = await world.json(["project", "add", name, "--repository-cwd", repository]);
  if (added.code !== 0) throw new Error(added.stdout + added.stderr);
  return repository;
};

/** Every file under a directory, relative, with its bytes as text, sorted; for tree comparisons. */
export const treeSnapshot = async (
  directory: string,
): Promise<Readonly<Record<string, string>>> => {
  const out: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        out[`${child}/`] = "";
        await walk(child);
      } else if (entry.isSymbolicLink()) out[child] = "<symlink>";
      else out[child] = await readFile(join(directory, child), "utf8");
    }
  };
  await walk("");
  return out;
};

/**
 * Creates a `git` shim that logs the working directory and arguments. `logging` then runs the real
 * git, `failing` fails the calls that reach a remote (`ls-remote`, `fetch`, `clone`) as an unreachable network would, and runs the rest, and `slow`
 * logs, touches `ls-remote.started` and pauses before the first `ls-remote`, then runs the real git.
 */
export const makeGitShim = async (
  parent: string,
  mode: "logging" | "failing" | "slow",
  pauseSeconds = 3,
): Promise<{
  readonly directory: string;
  readonly log: string;
  readonly started: string;
  readonly env: Record<string, string>;
}> => {
  const directory = await mkdtemp(join(parent, "shim-"));
  const log = join(directory, "git.log");
  const started = join(directory, "ls-remote.started");
  const real = Bun.which("git") ?? "/usr/bin/git";
  const record = `printf '%s\\t%s\\n' "$PWD" "$*" >> '${log}'\n`;
  const script =
    mode === "failing"
      ? `#!/bin/sh\n${record}case " $* " in *" ls-remote "*|*" fetch "*|*" clone "*) echo 'fatal: unable to access: Could not resolve host: github.com' >&2; exit 128;; esac\nexec '${real}' "$@"\n`
      : mode === "slow"
        ? `#!/bin/sh\n${record}case " $* " in *" ls-remote "*) touch '${started}'; sleep ${pauseSeconds};; esac\nexec '${real}' "$@"\n`
        : `#!/bin/sh\n${record}exec '${real}' "$@"\n`;
  await writeFile(join(directory, "git"), script);
  await chmod(join(directory, "git"), 0o755);
  await writeFile(log, "");
  return { directory, log, started, env: { PATH: `${directory}:${process.env["PATH"] ?? ""}` } };
};

/** The lines a git shim logged. */
export const shimCalls = async (log: string): Promise<ReadonlyArray<string>> =>
  (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0);
