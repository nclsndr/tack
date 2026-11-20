import { Crypto, FileSystem, Layer, Path, Terminal } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  BundleScanner,
  completePathWith,
  completeWith,
  type CompletionCandidate,
  Compression,
  ExecutionPlatform,
  Git,
  HostEnvironment,
  ImportRemote,
  Installation,
  LockProcess,
  makeSourceService,
  PortableLive,
  Reader,
  ReaderCorpus,
  runCliWith,
  Source,
  TerminalContext,
} from "@tackup/cli/core";
import { makeMemoryFileSystem, makeMemoryPath } from "./machine/memory-file-system.ts";
import { makeMemoryGit } from "./machine/memory-git.ts";
import type { MemoryVolume } from "./machine/memory-volume.ts";
import {
  browserInstallation,
  unavailableBundleScanner,
  nonInteractiveTerminal,
  pageLockProcess,
  unavailableCompression,
  unavailableExecutionPlatform,
  unavailableImportRemote,
  unavailableReader,
  unavailableReaderCorpus,
  unavailableSpawner,
  webCrypto,
} from "./machine/stand-ins.ts";

/** The machine one in-memory Tack runs on: its volume, the operator's home and the built-ins. */
export type BrowserMachine = {
  readonly volume: MemoryVolume;
  readonly home: string;
  /** The stable identity and volume path of Tack's own skills. */
  readonly builtInSource: { readonly id: string; readonly canonicalPath: string };
};

/** What one invocation printed, standard error included, and the exit code it ended with. */
export type BrowserRun = { readonly output: string; readonly exitCode: number };

/**
 * The services one in-memory Tack runs on, in `cwd`: the memory volume for files and paths, Git
 * read from it, Web Crypto, and clearly failing stand-ins for what needs a real machine.
 */
const servicesFor = (
  machine: BrowserMachine,
  options: { readonly cwd: string; readonly columns: number },
) => {
  const path = makeMemoryPath(options.cwd);
  const fileSystem = makeMemoryFileSystem(machine.volume, path);
  const platform = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fileSystem),
    Layer.succeed(Path.Path, path),
    Layer.succeed(Crypto.Crypto, webCrypto),
    Layer.succeed(Terminal.Terminal, nonInteractiveTerminal),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, unavailableSpawner),
  );
  return Layer.mergeAll(
    PortableLive,
    Layer.succeed(Source, makeSourceService(webCrypto, fileSystem, path, [machine.builtInSource])),
    Layer.succeed(Git, makeMemoryGit(machine.volume)),
    Layer.succeed(Reader, unavailableReader),
    Layer.succeed(ReaderCorpus, unavailableReaderCorpus),
    Layer.succeed(ImportRemote, unavailableImportRemote),
    Layer.succeed(ExecutionPlatform, unavailableExecutionPlatform),
    Layer.succeed(Installation, browserInstallation),
    Layer.succeed(Compression, unavailableCompression),
    Layer.succeed(BundleScanner, unavailableBundleScanner),
    Layer.succeed(LockProcess, pageLockProcess),
    Layer.succeed(HostEnvironment, { HOME: machine.home }),
    Layer.succeed(TerminalContext, {
      columns: options.columns,
      environment: { HOME: machine.home, TERM: "xterm-256color", FORCE_COLOR: "1" },
      stdinIsTerminal: false,
      stdoutIsTerminal: true,
    }),
  ).pipe(Layer.provideMerge(platform));
};

/**
 * Runs one `tack` invocation against the machine, in `cwd`, through the CLI's real command host
 * and route table. Only the platform underneath is the website's.
 */
export const runBrowserTack = async (
  machine: BrowserMachine,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly columns: number },
): Promise<BrowserRun> => {
  const services = servicesFor(machine, options);
  let output = "";
  const exitCode = await runCliWith({
    args,
    services,
    write: (text) => {
      output += text;
    },
  });
  return { output, exitCode };
};

/** The width completion reads the machine at; nothing it returns depends on it. */
const completionColumns = 80;

/** What Tab offers after `tack` and `words` for the word being typed, from the CLI's own grammar. */
export const completeBrowserTack = (
  machine: BrowserMachine,
  words: ReadonlyArray<string>,
  partial: string,
  cwd: string,
): Promise<ReadonlyArray<CompletionCandidate>> =>
  completeWith({
    words,
    partial,
    services: servicesFor(machine, { cwd, columns: completionColumns }),
  });

/** The paths a word being typed can continue with, by the rule Tack's completion uses. */
export const completeBrowserPath = (
  machine: BrowserMachine,
  partial: string,
  options: { readonly cwd: string; readonly files: boolean },
) =>
  completePathWith({
    partial,
    files: options.files,
    services: servicesFor(machine, { cwd: options.cwd, columns: completionColumns }),
  });
