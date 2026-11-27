import { Option } from "effect";
import { commandLine } from "../envelope/command-line.ts";
import type { HumanView } from "./human-view.ts";
import type { Style } from "./style.ts";
import { cell, flow, paragraph, table } from "./text.ts";
import { headerLines, hintLines, sections, withoutPayload } from "./view.ts";

/**
 * Tells the reader to read every line, and how to print the lines a tool cut from a long output.
 * The command stays whole, as a Next hint does, so that it can be copied.
 */
const readAllLines = (topic: string, lineCount: number, style: Style) => [
  ...paragraph(
    `Read all ${lineCount} lines of this guide before you act. If your tool shortened this output, print the lines you missed:`,
    { width: style.width },
  ),
  ...flow(
    [...commandLine("guide", topic).split(" "), "|", "sed", "-n", "'FIRST,LASTp'"].map((word) =>
      cell(word, style.cyan),
    ),
    { width: style.width, indent: 2, hang: 4, continuation: " \\", keepWords: true },
  ),
];

/**
 * `tack guide`: the guides by title, then the onboarding guide as the next command. `tack guide
 * TOPIC`: the guide as it ships, after a header that names the running version. The guide keeps its
 * own line breaks at any width, so that what an agent reads is the file the skill reads.
 */
export const renderGuide: HumanView<"guide"> = (envelope, { result }, style) => {
  if (envelope.result === null) return withoutPayload(envelope, undefined, style);
  if (Option.isNone(result) === true) return undefined;
  const guide = result.value;
  if (guide.kind === "guide") {
    const lines = guide.markdown.replace(/\n$/, "").split("\n");
    return sections(
      headerLines(envelope, `${guide.topic} · tack ${guide.version}`, style),
      readAllLines(guide.topic, lines.length, style),
      lines,
    );
  }
  return sections(
    headerLines(envelope, undefined, style),
    [
      style.bold("Guides"),
      ...table(
        guide.guides.map(({ topic, title }) => [cell(topic), cell(title)]),
        { width: style.width },
      ),
    ],
    hintLines([commandLine("guide", "onboarding")], style),
  );
};
