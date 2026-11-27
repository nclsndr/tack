import { Option } from "effect";
import type { ScriptShowPayloadSchema } from "../../domain/execution/execution-schema.ts";
import { commandLine } from "../envelope/command-line.ts";
import { frameView } from "./frame.ts";
import type { HumanView } from "./human-view.ts";
import { withoutPayload } from "./run-text.ts";
import { cell, table } from "./text.ts";
import { factRows } from "./view.ts";

type Declared = (typeof ScriptShowPayloadSchema.Type)["arguments"][number];

/** How an argument is spelled on the command line, such as `--state open|closed`. */
const spelling = (argument: Declared) => {
  const value =
    argument.type === "boolean"
      ? ""
      : argument.choices === undefined
        ? ` <${argument.type}>`
        : ` ${argument.choices.join("|")}`;
  return `--${argument.name}${value}${argument.multiple === true ? " ..." : ""}`;
};

/** Whether an argument must be passed, or what it falls back to. */
const requirement = (argument: Declared) =>
  argument.default !== undefined
    ? `default ${typeof argument.default === "string" ? argument.default : JSON.stringify(argument.default)}`
    : argument.optional === true
      ? "optional"
      : "required";

/** The words a run passes for an argument, with an uppercase placeholder for its value. */
const placeholder = (argument: Declared): ReadonlyArray<string> =>
  argument.type === "boolean"
    ? [`--${argument.name}`]
    : [
        `--${argument.name}`,
        argument.name
          .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
          .replaceAll("-", "_")
          .toUpperCase(),
      ];

const isRequired = (argument: Declared) =>
  argument.default === undefined && argument.optional !== true;

/** One declared script: what it does, its file, the arguments it takes and the secrets it reads. */
export const scriptShowView: HumanView<"script-show"> = (envelope, { result }, style) => {
  if (envelope.result === null) return withoutPayload(envelope, style);
  if (Option.isNone(result) === true) return undefined;
  const shown = result.value;
  const required = shown.arguments.filter(isRequired);
  return frameView(envelope, style, {
    body: [
      factRows(
        [
          ["Script", [cell(shown.address.name)]],
          ["Description", [cell(shown.description)]],
          ["File", [cell(shown.filePath)]],
        ],
        style,
      ),
      [
        style.bold("Arguments"),
        ...(shown.arguments.length === 0
          ? [`  ${style.dim("none")}`]
          : table(
              shown.arguments.map((argument) => [
                cell(spelling(argument)),
                cell(requirement(argument)),
                cell(argument.description ?? ""),
              ]),
              { width: style.width },
            )),
      ],
      shown.secrets.length === 0
        ? undefined
        : [
            style.bold("Secrets"),
            ...table(
              shown.secrets.map((secret) => [cell(secret), cell(`from TACK_${secret}`)]),
              { width: style.width },
            ),
          ],
    ],
    hints: [
      commandLine(
        "script-run",
        shown.address.name,
        ...(required.length === 0 ? [] : ["--", ...required.flatMap(placeholder)]),
      ),
    ],
  });
};
