import { Schema } from "effect";
import { lucideVersion, searchDocsIcons, docsIconCategories } from "@tackup/reader/icons";

/** One docs icon a lookup found, with the old Lucide name that matched, if any. */
const DocsIconHitSchema = Schema.Struct({
  name: Schema.String,
  alias: Schema.optionalKey(Schema.String),
});

/** One docs icon a lookup found, with the old Lucide name that matched, if any. */
type DocsIconHit = typeof DocsIconHitSchema.Type;

/**
 * The `docs icons` payload: the matches by category and the Lucide version they come from. The
 * query is absent when every icon is listed.
 */
export const DocsIconsPayloadSchema = Schema.Struct({
  kind: Schema.Literal("docs-icons"),
  query: Schema.optional(Schema.String),
  lucideVersion: Schema.String,
  count: Schema.Number,
  categories: Schema.Array(
    Schema.Struct({ category: Schema.String, icons: Schema.Array(DocsIconHitSchema) }),
  ),
});

/** What `tack docs icons` reports. */
export type DocsIconLookup = Omit<typeof DocsIconsPayloadSchema.Type, "kind">;

/**
 * The docs icons matching `word` in their name, category or old Lucide name, grouped by category;
 * without a word, the whole docs icon set.
 */
export function lookUpDocsIcons(word: string | undefined): DocsIconLookup {
  const matches =
    word === undefined
      ? docsIconCategories.flatMap(({ category, names }) =>
          names.map((name) => ({ name, category })),
        )
      : searchDocsIcons(word);
  const categories = docsIconCategories.flatMap(({ category }) => {
    const icons = matches
      .filter((match) => match.category === category)
      .map((match): DocsIconHit =>
        "alias" in match && match.alias !== undefined
          ? { name: match.name, alias: match.alias }
          : { name: match.name },
      );
    return icons.length === 0 ? [] : [{ category, icons }];
  });
  return { query: word, lucideVersion, count: matches.length, categories };
}
