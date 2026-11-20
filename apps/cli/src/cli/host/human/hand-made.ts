import type { HandMadeEntry } from "../../../domain/agents/hand-made-entry.ts";
import type { Style } from "./style.ts";
import { cell, table } from "./text.ts";

const entryWords: Readonly<Record<HandMadeEntry["entry"], string>> = {
  directory: "folder",
  file: "file",
  symlink: "link Tack did not make",
  special: "special file",
  unreadable: "unreadable entry",
};

/**
 * The entries Tack did not make in an agent folder, under one heading, each with its path, what it
 * is and the agent folder it was found in. Tack leaves them where they are; nothing when there are
 * none.
 */
export const handMadeLines = (entries: ReadonlyArray<HandMadeEntry>, style: Style) =>
  entries.length === 0
    ? []
    : [
        style.bold("Hand-made, left untouched"),
        ...table(
          entries.map(({ adapter, kind, path, entry }) => [
            cell(style.path(path)),
            cell(`${entryWords[entry]} · ${adapter} ${kind}`, style.dim),
          ]),
          { width: style.width, indent: 2 },
        ),
      ];
