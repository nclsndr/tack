/**
 * The drift check for guidance. Tack identifies a resource by source, kind and name, so no guide,
 * skill, help text or example may teach the removed shared/private owner. A mention passes only
 * when it names something the removal left in place or something that must say what was removed.
 */

/** One place where guidance mentions the removed owner. */
export type DriftHit = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly rule: string;
};

const rules: ReadonlyArray<{ readonly rule: string; readonly pattern: RegExp }> = [
  { rule: "owner-word", pattern: /\bowners?\b|--owner\b|<owner>|\bOWNER\b/ },
  {
    rule: "owner-tag",
    pattern:
      /\b(?:shared|private)\s+(?:resources?|skills?|commands?|context|scripts?|docs|areas?|sources?)\b|<shared\|private>|\bshared\/private\b|\(private\)/i,
  },
];

/**
 * The only mentions that stay. Each names its file and carries the reason it is not teaching the
 * removed owner. A new entry needs the same: a different sense of the word, or a repair message.
 */
const allowed: ReadonlyArray<{
  readonly file: RegExp;
  readonly line: RegExp;
  readonly reason: string;
}> = [
  {
    file: /(^|\/)CONTEXT\.md$/,
    line: /count and owners without changing/,
    reason:
      "The pending-removal diagnostic lists the namespaces that own removals: a different sense.",
  },
  {
    file: /(^|\/)CONTEXT\.md$/,
    line: /^_Avoid_: /,
    reason: "The glossary lists the retired owner, and `source owner`, as terms to avoid.",
  },
];

/** Reports each line of one guidance text that mentions the removed owner without an exception. */
export const scanGuidance = (file: string, text: string): ReadonlyArray<DriftHit> =>
  text.split("\n").flatMap((line, index) => {
    const hit = rules.find(({ pattern }) => pattern.test(line));
    return hit === undefined ||
      allowed.some((entry) => entry.file.test(file) && entry.line.test(line))
      ? []
      : [{ file, line: index + 1, text: line.trim(), rule: hit.rule }];
  });

/** Renders hits as one line each, for a failure message. */
export const describeDrift = (hits: ReadonlyArray<DriftHit>): string =>
  hits.map(({ file, line, rule, text }) => `${file}:${line} [${rule}] ${text}`).join("\n");

/** The slice of one command contract from the command tree that guidance is checked against. */
export type CommandContract = {
  readonly commandPath: ReadonlyArray<string>;
  readonly flags: ReadonlyArray<{ readonly name: string }>;
  readonly arguments: ReadonlyArray<unknown>;
};

/** The flags every command accepts, or that the root answers before it reads a command. */
const rootFlags: ReadonlyArray<string> = ["json", "state-dir", "help", "version"];

/** The bare read parents that also accept `list` and `ls`, as the CLI README documents. */
const listAliasParents: ReadonlyArray<string> = ["source", "project", "pick", "adapter", "docs"];

/** Reports whether a word stands for a value the reader supplies, such as `PROJECT` or `<command>`. */
const isPlaceholder = (word: string): boolean => /^[<A-Z]|\.\.\./.test(word);

/** The command fragments one line of guidance names: inline code spans, or a whole fenced line. */
const fragmentsOf = (line: string, fenced: boolean): ReadonlyArray<string> =>
  fenced
    ? [line.trim()]
    : [...line.matchAll(/`([^`]+)`/g)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      );

/**
 * Checks every Tack command a guide, skill or example names against the executable's own contracts:
 * its command path must exist and every flag must belong to that command. A word after a parent
 * that takes no arguments, such as `check` in `tack docs check`, is an unknown subcommand. A
 * fragment counts when it starts with `tack`, `bun tack` or `<executable>`, or, in inline code,
 * with a top-level command.
 */
export const scanCommands = (
  file: string,
  text: string,
  contracts: ReadonlyArray<CommandContract>,
): ReadonlyArray<DriftHit> => {
  const byPath = new Map(contracts.map((contract) => [contract.commandPath.join(" "), contract]));
  const prefixes = new Set(
    contracts.flatMap((contract) =>
      contract.commandPath.map((_, index) => contract.commandPath.slice(0, index + 1).join(" ")),
    ),
  );
  const parents = new Set(
    contracts.flatMap((contract) =>
      contract.commandPath
        .slice(0, -1)
        .map((_, index) => contract.commandPath.slice(0, index + 1).join(" ")),
    ),
  );
  const topLevel = new Set(contracts.map((contract) => contract.commandPath[0]));
  const hits: Array<DriftHit> = [];
  let fenced = false;
  text.split("\n").forEach((line, index) => {
    if (line.startsWith("```")) {
      fenced = !fenced;
      return;
    }
    for (const fragment of fragmentsOf(line, fenced)) {
      const words = fragment.replace(/^\$ /, "").replace(/#.*$/, "").trim().split(/\s+/);
      const first = words[0] ?? "";
      const start =
        first === "bun" && words[1] === "tack"
          ? 2
          : first === "tack" || first === "<executable>"
            ? 1
            : fenced === false && topLevel.has(first)
              ? 0
              : undefined;
      if (start === undefined) continue;
      const rest = words
        .slice(start)
        .filter(
          (word, at, all) =>
            word !== "--json" && word !== "--state-dir" && all[at - 1] !== "--state-dir",
        );
      const path: Array<string> = [];
      while (
        path.length < rest.length &&
        (prefixes.has([...path, rest[path.length] ?? ""].join(" ")) ||
          (listAliasParents.includes(path.join(" ")) &&
            ["list", "ls"].includes(rest[path.length] ?? "")))
      )
        path.push(rest[path.length] ?? "");
      const report = (rule: string) => hits.push({ file, line: index + 1, text: fragment, rule });
      const next = rest[path.length];
      if (path.length === 0) {
        if (next !== undefined && next.startsWith("-") === false && isPlaceholder(next) === false)
          report("command-unknown");
        continue;
      }
      const contract = byPath.get(
        path.filter((word) => word !== "list" && word !== "ls").join(" "),
      );
      if (
        parents.has(path.join(" ")) &&
        (contract?.arguments.length ?? 0) === 0 &&
        next !== undefined &&
        next.startsWith("-") === false &&
        isPlaceholder(next) === false
      )
        report("command-unknown");
      const operands = rest.slice(path.length);
      // Words after `--` belong to the command's operands, such as a script's own arguments.
      const end = operands.indexOf("--");
      for (const word of end === -1 ? operands : operands.slice(0, end)) {
        if (word.startsWith("--") === false) continue;
        const name = word.slice(2).replace(/=.*/, "");
        if (
          rootFlags.includes(name) === false &&
          contract?.flags.some((flag) => flag.name === name) !== true
        )
          report("flag-unknown");
      }
    }
  });
  return hits;
};

/** The code families that guidance names in backticks; each code must still exist in the CLI. */
const codeFamily =
  /^(?:profile|declaration|docs|source|release|legacy|resource|rollback|self|ci|terminal|no-adapters|root|destination|managed|removed|skill|command)-[a-z-]*[a-z]$/;

/**
 * Reports each backticked diagnostic code in a guide that the CLI no longer defines. `known`
 * answers whether the executable's source still carries the code as a string literal.
 */
export const scanCodes = (
  file: string,
  text: string,
  known: (code: string) => boolean,
): ReadonlyArray<DriftHit> =>
  text.split("\n").flatMap((line, index) =>
    [...line.matchAll(/`([a-z][a-z-]*[a-z])`/g)].flatMap((match) => {
      const code = match[1] ?? "";
      return codeFamily.test(code) && known(code) === false
        ? [{ file, line: index + 1, text: code, rule: "code-unknown" }]
        : [];
    }),
  );
