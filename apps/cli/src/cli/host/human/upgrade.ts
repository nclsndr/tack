import { Option } from "effect";
import { commandLine } from "../command-line.ts";
import { frameView } from "./frame.ts";
import type { HumanView } from "./render.ts";
import { withoutPayload } from "./run-text.ts";
import { cell, paragraph } from "./text.ts";
import { factRows } from "./view.ts";

const installed = {
  npm: "npm package",
  bun: "Bun package",
  source: "source checkout",
} as const;

/** How to upgrade the running Tack: its version, how it was installed, and the command to run. */
export const renderUpgradeGuide: HumanView<"upgrade" | "upgrade-status"> = (
  envelope,
  { result },
  style,
) => {
  if (envelope.result === null) return withoutPayload(envelope, style);
  if (Option.isNone(result) === true) return undefined;
  const guide = result.value;
  return frameView(envelope, style, {
    body: [
      factRows(
        [
          ["Running", [cell(guide.stamp)]],
          ["Installed", [cell(installed[guide.install])]],
        ],
        style,
      ),
      paragraph(guide.message, { width: style.width, indent: 2 }),
    ],
    // A package upgrade leaves the built-in skill links on the old version until init relinks them.
    hints: guide.command === null ? [] : [guide.command.join(" "), commandLine("machine-init")],
  });
};
