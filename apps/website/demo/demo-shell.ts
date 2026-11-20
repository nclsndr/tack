import { VolumeError, type VolumeErrorCode } from "./machine/memory-volume.ts";
import type { CompletionCandidate } from "@tackup/cli/core";
import {
  type BrowserMachine,
  completeBrowserPath,
  completeBrowserTack,
  runBrowserTack,
} from "./browser-tack.ts";
import { demoHome, makeDemoMachine, upstreamChanges, writeDemoFiles } from "./demo-world.ts";
import { homeRelative as relativeTo } from "./machine-view.ts";

/** What one command line printed and how it ended; `clear` asks the terminal to wipe its screen. */
export type ShellResult = {
  readonly output: string;
  readonly exitCode: number;
  readonly clear?: true;
};

const style = {
  directory: (text: string) => `\u001b[1;34m${text}\u001b[0m`,
  link: (text: string) => `\u001b[36m${text}\u001b[0m`,
  dim: (text: string) => `\u001b[2m${text}\u001b[0m`,
};

/** The commands the demo shell understands, besides `tack`, for `help` to list. */
const shellCommands = [
  ["tack <command>", "run Tack; try tack --help or tack doctor"],
  ["cd <dir>", "change directory; ~ is your home"],
  ["ls [-a] [-l] [path]", "list a folder; -l shows where links point"],
  ["tree [path]", "draw a folder and its links"],
  ["cat <file>", "print a file"],
  ["git pull", "bring in what a teammate pushed to a source"],
  ["pwd, clear, reset, help", "the usual, and reset restores the starting machine"],
] as const;

/** The shell's own command names, offered by Tab for the first word. */
const shellCommandNames = shellCommands.flatMap(([usage]) =>
  usage.split(", ").map((part) => part.replace(/ .*/u, "")),
);

/** The shell commands that take a path, and whether files count or only folders. */
const pathCommands: Readonly<Record<string, { readonly files: boolean }>> = {
  cd: { files: false },
  tree: { files: false },
  ls: { files: true },
  cat: { files: true },
};

/** What Tab turned a line into, and the choices it lists when several fit. */
export type ShellCompletion = {
  readonly line: string;
  /** The line before the word being completed, which every choice follows. */
  readonly head: string;
  readonly options: ReadonlyArray<CompletionCandidate>;
};

/** The longest start every value shares. `values` holds at least one value. */
const commonPrefix = (values: ReadonlyArray<string>) =>
  values.reduce((prefix, value) => {
    const end = Array.from({ length: prefix.length }, (_, index) => index).find(
      (index) => value[index] !== prefix[index],
    );
    return end === undefined ? prefix : prefix.slice(0, end);
  });

/**
 * Splits a command line into words: whitespace separates, single and double quotes group, and a
 * leading `~` names the home. `&&` stays a word of its own so the caller can chain on it.
 */
export const shellWords = (line: string): ReadonlyArray<string> =>
  [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => {
    const quoted = match[1] ?? match[2];
    if (quoted !== undefined) return quoted;
    const bare = match[0];
    return bare === "~" || bare.startsWith("~/") ? `${demoHome}${bare.slice(1)}` : bare;
  });

/** A path spelled for the prompt, with the demo home shown as `~`. */
const homeRelative = (path: string) => relativeTo(path, demoHome);

const failed = (output: string): ShellResult => ({ output: `${output}\n`, exitCode: 1 });

/** Prints each non-empty line, the way a shell command prints nothing for an empty folder. */
const printed = (lines: ReadonlyArray<string>): ShellResult => ({
  output: lines
    .filter((line) => line !== "")
    .map((line) => `${line}\n`)
    .join(""),
  exitCode: 0,
});

/** The message a shell prints for each volume failure. */
const volumeMessages: Readonly<Record<VolumeErrorCode, string>> = {
  EEXIST: "File exists",
  EINVAL: "Invalid argument",
  EISDIR: "Is a directory",
  ELOOP: "Too many levels of symbolic links",
  ENOENT: "No such file or directory",
  ENOTDIR: "Not a directory",
  ENOTEMPTY: "Directory not empty",
};

/**
 * One visitor's session on the demo machine: a working directory, the real Tack CLI, and the few
 * shell commands needed to look at what it links. `reset` restores the starting machine.
 */
export const makeDemoSession = () => {
  let machine: BrowserMachine = makeDemoMachine();
  let cwd = demoHome;
  let pulled = new Set<string>();

  const absolute = (path: string) => {
    const joined = path.startsWith("/") ? path : `${cwd}/${path}`;
    const parts = joined.split("/").reduce<Array<string>>((kept, part) => {
      if (part === "" || part === ".") return kept;
      return part === ".." ? kept.slice(0, -1) : [...kept, part];
    }, []);
    return `/${parts.join("/")}`;
  };

  /** Runs `operation`, turning a volume failure into the message a shell prints. */
  const onVolume = (command: string, operation: () => ShellResult): ShellResult => {
    try {
      return operation();
    } catch (error) {
      // Coverage skip: the volume throws only `VolumeError`; anything else is a bug to surface.
      /* v8 ignore next -- @preserve */
      if (error instanceof VolumeError === false) throw error;
      return failed(`${command}: ${homeRelative(error.path)}: ${volumeMessages[error.code]}`);
    }
  };

  const entryName = (directory: string, name: string, long: boolean) => {
    const path = `${directory}/${name}`;
    const type = machine.volume.lstat(path).type;
    if (type === "symlink")
      return long ? `${style.link(name)} -> ${machine.volume.readlink(path)}` : style.link(name);
    return type === "directory" ? style.directory(name) : name;
  };

  const list = (words: ReadonlyArray<string>) => {
    const flags = words.filter((word) => word.startsWith("-")).join("");
    const all = flags.includes("a");
    const long = flags.includes("l");
    const target = absolute(words.find((word) => word.startsWith("-") === false) ?? ".");
    return onVolume("ls", () => {
      if (machine.volume.stat(target).type !== "directory") return printed([homeRelative(target)]);
      const names = machine.volume
        .readdir(target)
        .filter((name) => all === true || name.startsWith(".") === false);
      if (long === true) return printed(names.map((name) => entryName(target, name, true)));
      return printed([names.map((name) => entryName(target, name, false)).join("  ")]);
    });
  };

  const treeLines = (directory: string, prefix: string): ReadonlyArray<string> => {
    const names = machine.volume.readdir(directory).filter((name) => name !== ".git");
    return names.flatMap((name, index) => {
      const last = index === names.length - 1;
      const path = `${directory}/${name}`;
      const line = `${prefix}${last ? "└── " : "├── "}${entryName(directory, name, true)}`;
      return machine.volume.lstat(path).type === "directory"
        ? [line, ...treeLines(path, `${prefix}${last ? "    " : "│   "}`)]
        : [line];
    });
  };

  const tree = (words: ReadonlyArray<string>) => {
    const target = absolute(words[0] ?? ".");
    return onVolume("tree", () => {
      if (machine.volume.stat(target).type !== "directory")
        return failed(`tree: ${homeRelative(target)}: Not a directory`);
      return printed([
        style.directory(homeRelative(target)),
        ...treeLines(machine.volume.realpath(target), ""),
      ]);
    });
  };

  const changeDirectory = (words: ReadonlyArray<string>) => {
    const target = absolute(words[0] ?? demoHome);
    return onVolume("cd", () => {
      if (machine.volume.stat(target).type !== "directory")
        return failed(`cd: ${homeRelative(target)}: Not a directory`);
      cwd = target;
      return printed([]);
    });
  };

  const gitPull = (words: ReadonlyArray<string>) => {
    if (words[0] !== "pull") return failed("git: only git pull is available in this demo");
    const root = Object.keys(upstreamChanges).find(
      (repository) => cwd === repository || cwd.startsWith(`${repository}/`),
    );
    const change = root === undefined ? undefined : upstreamChanges[root];
    if (root === undefined || change === undefined)
      return failed("fatal: no upstream to pull from in this folder; try cd ~/skills");
    if (pulled.has(root)) return printed(["Already up to date."]);
    pulled = new Set([...pulled, root]);
    writeDemoFiles(machine.volume, change.files);
    return printed(["Updating 3f2c1ab..9d41e07", "Fast-forward", change.summary]);
  };

  const help = () =>
    printed([
      "Commands in this demo:",
      ...shellCommands.map(([command, text]) => `  ${command.padEnd(26)}${style.dim(text)}`),
    ]);

  /** Runs one command, without `&&`. */
  const runOne = async (words: ReadonlyArray<string>, columns: number): Promise<ShellResult> => {
    const [command = "", ...rest] = words;
    switch (command) {
      case "":
        return printed([]);
      case "tack":
        return runBrowserTack(machine, rest, { cwd, columns });
      case "cd":
        return changeDirectory(rest);
      case "pwd":
        return printed([cwd]);
      case "ls":
        return list(rest);
      case "tree":
        return tree(rest);
      case "cat":
        return onVolume("cat", () => ({
          output: new TextDecoder().decode(machine.volume.readFile(absolute(rest[0] ?? ""))),
          exitCode: 0,
        }));
      case "git":
        return gitPull(rest);
      case "clear":
        return { output: "", exitCode: 0, clear: true };
      case "reset":
        machine = makeDemoMachine();
        cwd = demoHome;
        pulled = new Set();
        return { output: "The machine is back to its starting state.\n", exitCode: 0, clear: true };
      case "help":
        return help();
      default:
        return { output: `${command}: command not found; type help\n`, exitCode: 127 };
    }
  };

  /** What the word being typed (`partial`) can be after `words`, within one `&&` group. */
  const candidatesFor = async (
    words: ReadonlyArray<string>,
    partial: string,
  ): Promise<ReadonlyArray<CompletionCandidate>> => {
    const [command, ...rest] = words;
    if (command === undefined)
      return shellCommandNames
        .filter((name) => name.startsWith(partial))
        .map((value) => ({ value }));
    if (command === "tack") return completeBrowserTack(machine, rest, partial, cwd);
    const takesPath = pathCommands[command];
    if (takesPath === undefined) return [];
    const paths = await completeBrowserPath(machine, partial, { cwd, files: takesPath.files });
    return paths.map((value) => ({ value }));
  };

  return {
    /** The machine as it stands, for views that draw its files. */
    machine: () => machine,
    /** The working directory, spelled with `~` for the prompt. */
    prompt: () => homeRelative(cwd),
    /**
     * Runs a command line. Commands joined by `&&` run in order until one fails; their outputs are
     * printed together. `columns` is the terminal width Tack wraps its views to.
     */
    /**
     * Completes the word under the cursor at the end of `line`, the way a shell's Tab does: one
     * fitting value is written out, with a space after it unless it is a folder; several extend the
     * word to what they share and are listed. Tack's words come from the CLI's own grammar and
     * state; paths for `cd`, `ls`, `tree` and `cat` from the machine.
     */
    complete: async (line: string): Promise<ShellCompletion> => {
      const chain = line.lastIndexOf("&&");
      const segment = chain === -1 ? line : line.slice(chain + 2);
      const partial = /\S+$/.exec(segment)?.[0] ?? "";
      const head = line.slice(0, line.length - partial.length);
      const options = await candidatesFor(
        shellWords(segment.slice(0, segment.length - partial.length)),
        partial,
      );
      const [only] = options;
      if (options.length === 1 && only !== undefined)
        return {
          line: `${head}${only.value}${only.value.endsWith("/") ? "" : " "}`,
          head,
          options: [],
        };
      return {
        line: `${head}${options.length === 0 ? partial : commonPrefix(options.map((option) => option.value))}`,
        head,
        options,
      };
    },
    run: async (line: string, columns: number): Promise<ShellResult> => {
      const chain = shellWords(line).reduce<{
        readonly done: ReadonlyArray<ReadonlyArray<string>>;
        readonly current: ReadonlyArray<string>;
      }>(
        ({ done, current }, word) =>
          word === "&&"
            ? { done: [...done, current], current: [] }
            : { done, current: [...current, word] },
        { done: [], current: [] },
      );
      const groups = [...chain.done, chain.current];
      let result: ShellResult = printed([]);
      let output = "";
      for (const words of groups) {
        result = await runOne(words, columns);
        output = result.clear === true ? result.output : `${output}${result.output}`;
        if (result.exitCode !== 0) break;
      }
      return { ...result, output };
    },
  };
};

/** One visitor's session on the demo machine. */
export type DemoSession = ReturnType<typeof makeDemoSession>;
