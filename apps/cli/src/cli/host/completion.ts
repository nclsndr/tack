import { Effect, FileSystem, Path } from "effect";
import { agentAdapterIds } from "../../domain/agents/agent-adapter.ts";
import { guideTopics } from "../../domain/guides/guide-schema.ts";
import type { ResourceKind } from "../../domain/resources/kinds.ts";
import { catalogSelectableEntries, type Catalog } from "../../domain/sources/catalog-schema.ts";
import { readInvocationSnapshot } from "../../features/snapshot/command-snapshot.ts";
import { shortestReference, sourceQualifier } from "../../features/sources/resource-reference.ts";
import { describeTree } from "../commands/manifest.ts";
import { HostEnvironment } from "./host-environment.ts";
import { hostStateOptions } from "./host-state-options.ts";

/** One value Tab may put in place of the word being typed, with what it means when known. */
export type CompletionCandidate = {
  readonly value: string;
  readonly description?: string | undefined;
};

/** Where the values of an operand or a value flag come from. `free` text has none to offer. */
type ValueSource =
  | "free"
  | "projects"
  | "sources"
  | "registrations"
  | "selectable"
  | "docs"
  | "scripts"
  | "adapters"
  | "guides"
  | "directories"
  | "paths";

/** Value flags by name: a flag means the same in every command that accepts it. */
const flagSources: Readonly<Record<string, ValueSource>> = {
  "--state-dir": "directories",
  "--project": "projects",
  "--cwd": "directories",
  "--repository-cwd": "directories",
  "--root": "directories",
  "--target-root": "directories",
  "--target-home": "directories",
  "--input-file": "paths",
  "--input-json": "free",
  "--type": "free",
  "--status": "free",
  "--tag": "free",
  "--limit": "free",
  "--offset": "free",
  "--port": "free",
  "--timeout": "free",
  "--destination": "free",
  "--default": "free",
  "--name": "free",
  "--into": "free",
  "--skill": "free",
  "--config": "paths",
};

/** Operands by command path and name, as `<path> <name>`. */
const argumentSources: Readonly<Record<string, ValueSource>> = {
  "check <path>": "directories",
  "guide <topic>": "guides",
  "types <path>": "directories",
  "source add <source-path>": "directories",
  "source relocate <registration-id>": "registrations",
  "source relocate <source-path>": "directories",
  "source remove <source>": "sources",
  "docs attach <reference>": "docs",
  "docs detach <reference>": "docs",
  "docs search <query>": "free",
  "docs icons <word>": "free",
  "script run <reference>": "scripts",
  "script run <arguments>": "free",
  "script show <reference>": "scripts",
  "script history show <run-id>": "free",
  "profile apply <profile>": "free",
  "profile save <source-path>": "directories",
  "profile save <profile-name>": "free",
  "profile adopt <profile>": "free",
  "profile export <profile>": "free",
  "profile export <output>": "paths",
  "profile inspect-bundle <file>": "paths",
  "profile apply-bundle <file>": "paths",
  "import add <location>": "free",
  "import remove <reference>": "free",
  "project add <name>": "free",
  "project remove <name>": "projects",
  "pick include <reference>": "selectable",
  "pick exclude <reference>": "selectable",
  "pick remove <reference>": "selectable",
  "adapter enable <adapter>": "adapters",
  "adapter disable <adapter>": "adapters",
};

/**
 * Where the values of one operand (`name`) or value flag (`--name`) of a command come from, or
 * `undefined` when completion does not know it; a test holds every one in the grammar declared.
 */
export const valueSourceOf = (commandPath: ReadonlyArray<string>, name: string) =>
  name.startsWith("--") ? flagSources[name] : argumentSources[`${commandPath.join(" ")} <${name}>`];

type Node = Effect.Success<ReturnType<typeof describeTree>>[number];
type Flag = Node["grammar"]["flags"][number];

/** The values a choice flag accepts, or `undefined` for any other flag. */
export const choicesOf = (flag: Flag) => ("choices" in flag ? flag.choices : undefined);

/** What the word being typed fills, read from the words before it. */
type Slot =
  | { readonly kind: "subcommands"; readonly node: Node }
  | { readonly kind: "flags"; readonly node: Node; readonly used: ReadonlySet<string> }
  | { readonly kind: "choices"; readonly choices: ReadonlyArray<string> }
  | { readonly kind: "values"; readonly source: ValueSource; readonly taken: ReadonlySet<string> }
  | { readonly kind: "none" };

type Walk = {
  readonly node: Node;
  readonly used: ReadonlySet<string>;
  readonly operands: ReadonlyArray<string>;
  /** The value flag the previous word opened, whose value is the word being typed. */
  readonly pending: Flag | undefined;
};

const nodeAt = (tree: ReadonlyArray<Node>, commandPath: ReadonlyArray<string>) =>
  tree.find(
    ({ grammar }) =>
      grammar.commandPath.length === commandPath.length &&
      grammar.commandPath.every((word, index) => commandPath[index] === word),
  );

/**
 * Follows the words through the grammar: subcommand names, flags with the values they take, and
 * the operands in order. No command has both subcommands and operands, so a word names a
 * subcommand exactly when the command reached so far has one by that name.
 */
const walk = (tree: ReadonlyArray<Node>, root: Node, words: ReadonlyArray<string>): Walk =>
  words.reduce<Walk>(
    (state, word) => {
      if (state.pending !== undefined) return { ...state, pending: undefined };
      if (word.startsWith("--")) {
        const flag = state.node.grammar.flags.find((candidate) => `--${candidate.name}` === word);
        return {
          ...state,
          used: new Set([...state.used, word]),
          pending: flag !== undefined && flag.type !== "boolean" ? flag : undefined,
        };
      }
      const child = nodeAt(tree, [...state.node.grammar.commandPath, word]);
      return child === undefined
        ? { ...state, operands: [...state.operands, word] }
        : { ...state, node: child };
    },
    { node: root, used: new Set(), operands: [], pending: undefined },
  );

const slotOf = (tree: ReadonlyArray<Node>, words: ReadonlyArray<string>, partial: string): Slot => {
  const root = nodeAt(tree, []);
  // Coverage skip: the tree always describes the root command.
  /* v8 ignore next -- @preserve */
  if (root === undefined) return { kind: "none" };
  const { node, used, operands, pending } = walk(tree, root, words);
  const commandPath = node.grammar.commandPath;
  if (pending !== undefined) {
    const choices = choicesOf(pending);
    return choices === undefined
      ? {
          kind: "values",
          source: valueSourceOf(commandPath, `--${pending.name}`) ?? "free",
          taken: new Set(),
        }
      : { kind: "choices", choices };
  }
  if (partial.startsWith("-")) return { kind: "flags", node, used };
  if (operands.length === 0 && node.subcommands.length > 0) return { kind: "subcommands", node };
  const declared = node.grammar.arguments;
  const last = declared.at(-1);
  const argument = declared[operands.length] ?? (last?.variadic === true ? last : undefined);
  if (argument === undefined) return { kind: "none" };
  return {
    kind: "values",
    source: valueSourceOf(commandPath, argument.name) ?? "free",
    taken: new Set(argument.variadic === true ? operands : []),
  };
};

/** The value of `--state-dir` on the line, which decides the state completion reads. */
const stateDirectoryOf = (words: ReadonlyArray<string>) => {
  const index = words.indexOf("--state-dir");
  return index === -1 ? undefined : words[index + 1];
};

const referencesOf = (catalog: Catalog, kinds: ReadonlyArray<ResourceKind>) =>
  catalog.entries
    .filter((entry) => kinds.includes(entry.address.kind))
    .map((entry) => shortestReference(catalog, entry));

/** The values one source offers in the state the line names. */
const stateValues = Effect.fnUntraced(function* (
  source: "projects" | "sources" | "registrations" | "selectable" | "docs" | "scripts",
  words: ReadonlyArray<string>,
) {
  const snapshot = yield* readInvocationSnapshot(
    yield* hostStateOptions(stateDirectoryOf(words), false),
  );
  if (source === "projects") return snapshot.state.data.projects.map((project) => project.name);
  if (source === "registrations") return snapshot.state.data.sources.map((entry) => entry.id);
  const catalog = yield* snapshot.catalog;
  if (source === "sources")
    return (catalog.sources ?? []).map((inspection) =>
      sourceQualifier(catalog, inspection.registration.id),
    );
  if (source === "selectable")
    return catalogSelectableEntries(catalog).map((entry) => shortestReference(catalog, entry));
  return referencesOf(catalog, [source === "docs" ? "docs" : "script"]);
});

/**
 * The folders (and with `files`, the files) a path being typed can continue with. A leading `~`
 * stands for the home and stays as typed; each folder ends with `/` so Tab can go on into it, and
 * dot entries show only once the word starts with a dot. It fails when the folder cannot be read.
 */
export const completePath = Effect.fnUntraced(function* (partial: string, files: boolean) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = (yield* HostEnvironment)["HOME"];
  const expanded =
    home !== undefined && partial.startsWith("~/") ? `${home}${partial.slice(1)}` : partial;
  const typedFolder = partial.slice(0, partial.lastIndexOf("/") + 1);
  const folder = expanded.slice(0, expanded.lastIndexOf("/") + 1);
  const stem = expanded.slice(folder.length);
  const directory = path.resolve(folder === "" ? "." : folder);
  const names = yield* fileSystem.readDirectory(directory);
  const entries = yield* Effect.forEach(
    names.filter(
      (name) => name.startsWith(stem) && (name.startsWith(".") === false || stem.startsWith(".")),
    ),
    (name) =>
      fileSystem.stat(path.join(directory, name)).pipe(
        Effect.map((info) =>
          info.type === "Directory"
            ? [`${typedFolder}${name}/`]
            : files === true
              ? [`${typedFolder}${name}`]
              : [],
        ),
        Effect.orElseSucceed(() => []),
      ),
  );
  return entries.flat();
});

const sorted = (values: ReadonlyArray<string>) => [...new Set(values)].sort();

/**
 * What Tab offers for the word being typed (`partial`) after the words before it, all after
 * `tack`. Subcommands, flags and choice values come from the command tree the parser runs, in its
 * order; projects, sources, references and paths come from the state and the file system, sorted.
 * Nothing it cannot read fails: a missing state or folder offers no values.
 */
export const completeTack = Effect.fnUntraced(function* (
  words: ReadonlyArray<string>,
  partial: string,
) {
  const tree = yield* describeTree();
  const slot = slotOf(tree, words, partial);
  const matching = (candidates: ReadonlyArray<CompletionCandidate>) =>
    candidates.filter((candidate) => candidate.value.startsWith(partial));
  if (slot.kind === "none") return [];
  if (slot.kind === "subcommands")
    return matching(
      slot.node.subcommands.map((subcommand) => ({
        value: subcommand.name,
        description: subcommand.description,
      })),
    );
  if (slot.kind === "flags")
    return matching(
      slot.node.grammar.flags
        .filter((flag) => slot.used.has(`--${flag.name}`) === false)
        .map((flag) => ({ value: `--${flag.name}`, description: flag.description })),
    );
  if (slot.kind === "choices") return matching(slot.choices.map((value) => ({ value })));
  const source = slot.source;
  const values =
    source === "free"
      ? []
      : source === "adapters"
        ? agentAdapterIds
        : source === "guides"
          ? guideTopics
          : source === "directories" || source === "paths"
            ? yield* completePath(partial, source === "paths").pipe(Effect.orElseSucceed(() => []))
            : sorted(
                yield* stateValues(source, words).pipe(Effect.catchCause(() => Effect.succeed([]))),
              );
  return matching(
    values.filter((value) => slot.taken.has(value) === false).map((value) => ({ value })),
  );
});
