import { Option, Schema } from "effect";
import { GuideIndexSchema, GuideSchema } from "../../../domain/guides/guide-schema.ts";
import { commandLine } from "../command-line.ts";
import type { HumanView } from "./render.ts";
import type { Style } from "./style.ts";
import { cell, flow, paragraph, table } from "./text.ts";
import { headerLines, hintLines, sections, withoutPayload } from "./view.ts";

const decodeGuide = Schema.decodeUnknownOption(GuideSchema);
const decodeIndex = Schema.decodeUnknownOption(GuideIndexSchema);

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
export const renderGuide: HumanView = (envelope, style) => {
  if (envelope.result === null) return withoutPayload(envelope, undefined, style);
  const guide = Option.getOrUndefined(decodeGuide(envelope.result));
  if (guide !== undefined) {
    const lines = guide.markdown.replace(/\n$/, "").split("\n");
    return sections(
      headerLines(envelope, `${guide.topic} · tack ${guide.version}`, style),
      readAllLines(guide.topic, lines.length, style),
      lines,
    );
  }
  const index = Option.getOrUndefined(decodeIndex(envelope.result));
  if (index === undefined) return undefined;
  return sections(
    headerLines(envelope, undefined, style),
    [
      style.bold("Guides"),
      ...table(
        index.guides.map(({ topic, title }) => [cell(topic), cell(title)]),
        { width: style.width },
      ),
    ],
    hintLines([commandLine("guide", "onboarding")], style),
  );
};
