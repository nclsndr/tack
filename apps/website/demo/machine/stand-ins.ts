import { Crypto, Effect, PlatformError, Terminal } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  BundleScanner,
  Compression,
  defaultImportLimits,
  executionError,
  ExecutionPlatform,
  FigureCheckError,
  ImportFetchError,
  ImportRemote,
  Installation,
  LockProcess,
  Reader,
  ReaderCorpus,
  ReaderSearchError,
  ReaderStartupError,
} from "@tackup/cli/core";

/** Why a capability is missing where Tack runs over a memory volume, such as the browser demo. */
export const unavailableMessage = (capability: string) =>
  `${capability} needs a real machine and is not available in this in-memory Tack.`;

/** Effect's crypto over the Web Crypto API, which browsers, Node and Bun all provide. */
export const webCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: async () =>
        new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, data.slice())),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "Crypto",
          method: "digest",
          description: "Could not compute digest",
          cause,
        }),
    }),
});

/** The docs reader serves HTTP from a local process, which a memory volume cannot host. */
export const unavailableReader = {
  start: () =>
    Effect.fail(
      new ReaderStartupError({
        kind: "engine",
        message: unavailableMessage("The docs reader"),
      }),
    ),
} satisfies Reader["Service"];

/** Docs search and figure checks bundle the reader engine, which stays out of this build. */
export const unavailableReaderCorpus = {
  loadProject: () =>
    Effect.fail(
      new ReaderSearchError({ kind: "read", message: unavailableMessage("Docs search") }),
    ),
  checkFigures: () =>
    Effect.fail(
      new FigureCheckError({ kind: "read", message: unavailableMessage("Figure checks") }),
    ),
} satisfies ReaderCorpus["Service"];

const importUnavailable = () =>
  Effect.fail(
    new ImportFetchError({
      code: "import-git-unavailable",
      message: unavailableMessage("Importing from a Git remote"),
    }),
  );

/** Imports fetch from Git remotes over the network. */
export const unavailableImportRemote = {
  limits: defaultImportLimits,
  probe: importUnavailable(),
  listRefs: importUnavailable,
  open: importUnavailable,
} satisfies ImportRemote["Service"];

const noScripts = () =>
  Effect.fail(
    executionError("worker", "worker_unavailable", unavailableMessage("Running scripts")),
  );

/** Scripts run in a separate worker process, and their history lives beside it on disk. */
export const unavailableExecutionPlatform = {
  cancellation: () =>
    Effect.sync(() => {
      const controller = new AbortController();
      return { signal: controller.signal, onRepeatSignal: () => () => {}, close: () => {} };
    }),
  input: noScripts,
  packageReady: noScripts,
  createHistory: noScripts,
  finishHistory: noScripts,
  listHistory: () => Effect.succeed({ runs: [], issues: [] }),
  countHistory: () => Effect.succeed(0),
  showHistory: () => Effect.succeed(undefined),
  clearHistory: () => Effect.succeed(0),
  worker: noScripts,
} satisfies ExecutionPlatform["Service"];

/** Child processes, which only Git and scripts would start, do not exist in memory. */
export const unavailableSpawner = ChildProcessSpawner.make((command) =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      description: unavailableMessage(
        `Starting ${command._tag === "StandardCommand" ? command.command : "a process"}`,
      ),
    }),
  ),
);

/**
 * A terminal that is never interactive: the host only opens the explorer on an interactive
 * terminal, so nothing reads keys from it. Reading a line ends at once, as on a closed input.
 */
export const nonInteractiveTerminal = Terminal.make({
  columns: Effect.succeed(80),
  rows: Effect.succeed(24),
  readInput: Effect.die(new Error(unavailableMessage("Reading keys"))),
  readLine: Effect.fail(new Terminal.QuitError()),
  display: () => Effect.void,
});

/** A browser install reads as an npm one, keeps no built-ins copies and never crashes on purpose. */
export const browserInstallation = {
  kind: "npm",
  crashPoint: () => Effect.void,
} satisfies Installation["Service"];

const noGzip = () => {
  throw new Error(unavailableMessage("Writing and reading profile bundles"));
};

/** Profile bundles are gzip archives written to disk; neither exists here. */
export const unavailableCompression = {
  gzip: noGzip,
  gunzip: noGzip,
} satisfies Compression["Service"];

/**
 * A browser has no runtime modules a bundle could import without a package, and the reference scan
 * would bundle JavaScript, HTML and MDX parsers the page never needs.
 */
export const unavailableBundleScanner = {
  builtinModules: [],
  references: () => {
    throw new Error(unavailableMessage("Scanning profile bundle references"));
  },
} satisfies BundleScanner["Service"];

/** The page is the only process: it owns every lock it publishes, and no other owner can die. */
export const pageLockProcess = {
  pid: 1,
  isGone: () => false,
} satisfies (typeof LockProcess)["Service"];
