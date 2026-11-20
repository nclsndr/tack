import { Option, Schema } from "effect";
import { DocsIconsPayloadSchema } from "../../../features/reader/icon-lookup.ts";
import { frameView } from "./frame.ts";
import type { HumanView } from "./render.ts";
import { withoutPayload } from "./run-text.ts";
import { cell } from "./text.ts";
import { factRows } from "./view.ts";

const decodeLookup = Schema.decodeUnknownOption(DocsIconsPayloadSchema);

/** The matching docs icons under their category, an old Lucide name beside its current one. */
export const docsIconsView: HumanView = (envelope, style) => {
  if (envelope.result === null) return withoutPayload(envelope, style);
  const lookup = Option.getOrUndefined(decodeLookup(envelope.result));
  if (lookup === undefined) return undefined;
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
