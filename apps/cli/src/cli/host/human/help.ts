import { Option, Schema } from "effect";
import { HelpPayloadSchema } from "../../commands/index.ts";
import { argvLine } from "../command-line.ts";
import type { PublicEnvelope } from "../public-outcome.ts";
import type { Style } from "./style.ts";
import { mapModes, operationMap } from "./help-map.ts";
import { cell, flow, paragraph, table, type Cell } from "./text.ts";
import {
  diagnosticLines,
  factRows,
  headerLines,
  hintLines,
  sections,
  withoutPayload,
} from "./view.ts";

const decodeHelp = Schema.decodeUnknownOption(HelpPayloadSchema);

type Help = typeof HelpPayloadSchema.Type;

/**
 * The flags the root command declares for every operation. Help lists them after an operation's own
 * flags, under a separate heading. A test checks this list against the root help payload.
 */
export const rootFlagNames: ReadonlyArray<string> = ["json", "state-dir", "version"];

const flagUsage = (flag: Help["flags"][number]) =>
  flag.type === "boolean"
    ? `--${flag.name}`
    : `--${flag.name} <${flag.choices === undefined ? flag.type : flag.choices.join("|")}>`;

const flagRows = (flags: Help["flags"], style: Style): ReadonlyArray<ReadonlyArray<Cell>> =>
  flags.map((flag) => [
    cell(
      `${flagUsage(flag)}${flag.required ? " (required)" : ""}`,
      flag.required ? style.yellow : undefined,
    ),
    cell(flag.description ?? ""),
  ]);

const block = (
  title: string,
  rows: ReadonlyArray<ReadonlyArray<Cell>>,
  style: Style,
): ReadonlyArray<string> | undefined =>
  rows.length === 0 ? undefined : [style.bold(title), ...table(rows, { width: style.width })];

/**
 * The next commands for a group's help page: the help of every subcommand, since a group's
 * subcommands are alternatives rather than steps. The root has none.
 */
const nextCommands = (help: Help): ReadonlyArray<string> =>
  help.commandPath.length === 0
    ? []
    : help.subcommands.map(({ name }) => argvLine(["tack", ...help.commandPath, name, "--help"]));

/** The root help page body after the description: usage, the legend and the operation map. */
const mapLines = (style: Style): ReadonlyArray<string> => [
  ...factRows(
    [
      ["Usage", [cell("tack [--json] [--state-dir <dir>] <command> [flags]")]],
      ["Help", [cell("tack <command> --help shows the flags and examples of one command")]],
    ],
    style,
  ),
  "",
  style.bold("Modes"),
  ...table(
    mapModes.map(([mode, meaning]) => [cell(mode), cell(meaning)]),
    { width: style.width },
  ),
  ...operationMap.flatMap(({ title, rows }) => [
    "",
    style.bold(title),
    ...table(
      rows.map(({ usage, mode, summary }) => [cell(usage), cell(mode, style.dim), cell(summary)]),
      { width: style.width },
    ),
  ]),
  "",
  ...factRows(
    [
      [
        "Target",
        [
          cell(
            "--project <name> takes a registered project name, not a path; --user and --all widen it. Without them the project containing the current directory is used.",
          ),
        ],
      ],
      [
        "Output",
        [
          cell(
            "text by default. --json prints one envelope for programs; its payload is stable only for status, sync, doctor, upgrade and --version.",
          ),
        ],
      ],
    ],
    style,
  ),
];

/** The titled `term  meaning` blocks a command declares, such as what each status value means. */
const noteBlocks = (help: Help, style: Style): ReadonlyArray<ReadonlyArray<string>> =>
  (help.notes ?? []).map(({ title, rows }) => [
    style.bold(title),
    ...table(
      rows.map(({ term, text }) => [cell(term), cell(text)]),
      { width: style.width },
    ),
  ]);

/** Renders `help` and `--help` as a one-screen summary of a command path. */
export const renderHelp = (envelope: PublicEnvelope, style: Style): string | undefined =>
  Option.match(decodeHelp(envelope.result), {
    onNone: () => withoutPayload(envelope, undefined, style),
    onSome: (help) => {
      const ownFlags = help.flags.filter(({ name }) => !rootFlagNames.includes(name));
      const rootFlags = help.flags.filter(({ name }) => rootFlagNames.includes(name));
      const isRoot = help.commandPath.length === 0;
      return sections(
        headerLines(envelope, isRoot ? "root" : help.commandPath.join(" "), style),
        paragraph(help.description, { width: style.width }),
        isRoot
          ? mapLines(style)
          : factRows(
              [
                ["Usage", [cell(help.usage)]],
                ...(help.mutation === undefined ? [] : [["Mode", [cell(help.mutation)]] as const]),
              ],
              style,
            ),
        block(
          "Arguments",
          help.arguments.map((argument) => [
            cell(
              `<${argument.name}>${argument.variadic ? "..." : ""}${argument.required ? "" : " (optional)"}`,
            ),
            cell(argument.description ?? ""),
          ]),
          style,
        ),
        isRoot
          ? undefined
          : block(
              "Commands",
              help.subcommands.map((subcommand) => [
                cell(subcommand.name),
                cell(subcommand.description),
              ]),
              style,
            ),
        block("Flags", flagRows(ownFlags, style), style),
        block(isRoot ? "Flags" : "Root flags", flagRows(rootFlags, style), style),
        help.examples.length === 0
          ? undefined
          : [
              style.bold("Examples"),
              ...help.examples.flatMap((example) => [
                ...flow(
                  example.command.split(" ").map((word) => cell(word, style.cyan)),
                  { width: style.width, indent: 2, hang: 4, continuation: " \\", keepWords: true },
                ),
                ...(example.description === undefined
                  ? []
                  : paragraph(example.description, {
                      width: style.width,
                      indent: 4,
                      paint: style.dim,
                    })),
              ]),
            ],
        ...noteBlocks(help, style),
        diagnosticLines(envelope.diagnostics, style),
        hintLines(nextCommands(help), style),
      );
    },
  });
