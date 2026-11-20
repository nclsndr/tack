import { Option, Schema } from "effect";
import { VersionReportSchema } from "../../../version.ts";
import type { HumanView } from "./render.ts";
import { cell } from "./text.ts";
import { factRows, headerLines, sections } from "./view.ts";

const decodeReport = Schema.decodeUnknownOption(VersionReportSchema);

/** Shows the running version, its commit, and whether it is a source run or a release. */
export const renderVersion: HumanView = (envelope, style) => {
  const report = Option.getOrUndefined(decodeReport(envelope.result));
  if (report === undefined) return undefined;
  return sections(
    headerLines(envelope, undefined, style),
    factRows(
      [
        ["Version", [cell(report.stamp, style.bold)]],
        ["Commit", [cell(report.commit ?? "none")]],
        ["Run", [cell(report.sourceRun ? "source run" : "release build")]],
        ["State format", [cell(String(report.stateFormat))]],
      ],
      style,
    ),
  );
};
