import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { commandNameOf, parseInvocation } from "../../src/cli/commands/index.ts";

/** Splits a hint like a POSIX shell would for the single-quote and plain-word forms views emit. */
const shellSplit = (line: string): ReadonlyArray<string> => {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quoted) {
      if (character === "'") quoted = false;
      else current += character;
    } else if (character === "'") {
      quoted = true;
      inWord = true;
    } else if (character === "\\" && line[index + 1] === "'") {
      current += "'";
      index += 1;
    } else if (/\s/.test(character)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += character;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
};

// oxlint-disable-next-line no-control-regex -- Hints are read from plain and colored output alike.
const ansi = /\u001B\[[0-9;]*m/g;

/**
 * The `tack ...` commands listed under a view's `Next` heading. A command too long for the width
 * continues on the next line after a trailing backslash, and is read back as one line.
 */
export const hintsIn = (output: string): ReadonlyArray<string> => {
  const lines = output.replace(ansi, "").split("\n");
  const start = lines.indexOf("Next");
  if (start === -1) return [];
  return lines
    .slice(start + 1)
    .map((line) => line.trim())
    .join("\n")
    .replaceAll(" \\\n", " ")
    .split("\n")
    .filter((line) => line.startsWith("tack "));
};

/** The operation name the real grammar parses a hint as; fails when the grammar rejects it. */
const parsedOperationOf = (hint: string) =>
  parseInvocation(shellSplit(hint).slice(1)).pipe(
    Effect.map(({ invocation }) => commandNameOf(invocation._tag)),
    Effect.provide(BunServices.layer),
  );

/** Parses every hint in a view through the real grammar; returns their operation names. */
export const parseHintsIn = (output: string) =>
  Effect.forEach(hintsIn(output), (hint) => parsedOperationOf(hint));
