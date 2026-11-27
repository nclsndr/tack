import { Option } from "effect";
import { frameView } from "./frame.ts";
import type { HumanView } from "./render.ts";
import { withoutPayload } from "./run-text.ts";
import { cell } from "./text.ts";
import { factRows } from "./view.ts";

/** The matching docs icons under their category, an old Lucide name beside its current one. */
export const docsIconsView: HumanView<"docs-icons"> = (envelope, { result }, style) => {
  if (envelope.result === null) return withoutPayload(envelope, style);
  if (Option.isNone(result) === true) return undefined;
  const lookup = result.value;
  return frameView(envelope, style, {
    body: [
      factRows(
        [
          ["Lucide", [cell(lookup.lucideVersion)]],
          ["Matches", [cell(String(lookup.count))]],
        ],
        style,
      ),
      lookup.categories.flatMap(({ category, icons }) => [
        category,
        ...icons.map(
          ({ name, alias }) => `  ${name}${alias === undefined ? "" : ` (was ${alias})`}`,
        ),
      ]),
    ],
  });
};
