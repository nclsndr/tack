import { Option } from "effect";
import type { HumanView } from "./human-view.ts";
import { cell } from "./text.ts";
import { factRows, headerLines, sections } from "./view.ts";

/** Shows the running version, its commit, and whether it is a source run or a release. */
export const renderVersion: HumanView<"version"> = (envelope, { result }, style) => {
  if (Option.isNone(result) === true) return undefined;
  const report = result.value;
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
