import { Option, Schema } from "effect";
import { commandLine } from "../command-line.ts";
import { frameView } from "./frame.ts";
import type { HumanView } from "./render.ts";
import { withoutPayload } from "./run-text.ts";
import { cell, table } from "./text.ts";
import { factRows } from "./view.ts";

const TypesPlanSchema = Schema.Struct({
  directory: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      action: Schema.Literals(["create", "update", "unchanged", "keep"]),
    }),
  ),
});
const decodePlan = Schema.decodeUnknownOption(TypesPlanSchema);
type Action = (typeof TypesPlanSchema.Type)["files"][number]["action"];

const planned: Record<Action, string> = {
  create: "create",
  update: "update",
  unchanged: "unchanged",
  keep: "keep as is",
};
const done: Record<Action, string> = {
  create: "created",
  update: "updated",
  unchanged: "unchanged",
  keep: "kept as is",
};

/** The editor types `tack types` would write, or wrote, into one source folder. */
export const typesView: HumanView = (envelope, style) => {
  const applied = envelope.applied !== null;
  const plan = Option.getOrUndefined(decodePlan(applied ? envelope.applied : envelope.plan));
  if (plan === undefined) return withoutPayload(envelope, style);
  const writes = plan.files.some(({ action }) => action === "create" || action === "update");
  return frameView(envelope, style, {
    body: [
      factRows([["Source", [cell(style.path(plan.directory))]]], style),
      [
        style.bold(applied ? "Files" : "Plan"),
        ...table(
          plan.files.map(({ path, action }) => [
            cell((applied ? done : planned)[action]),
            cell(style.path(path)),
          ]),
          { width: style.width },
        ),
      ],
    ],
    hints: applied || writes === false ? [] : [commandLine("types", plan.directory, "--apply")],
  });
};
