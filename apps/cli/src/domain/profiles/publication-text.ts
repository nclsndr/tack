import { Yaml } from "../runtime-neutral.ts";
import { Schema } from "effect";
import { deepStrictEqual } from "../identity/portable.ts";
import { isMap, isScalar, isSeq, parseDocument, stringify } from "yaml";
import type { ProfilePublication } from "./profile-schema.ts";
import {
  applyDeclarationTextEdits,
  type DeclarationTextEdit,
} from "../sources/declaration-text.ts";
import { SourceDeclarationSchema } from "../sources/source-schema.ts";

/** Edits YAML node ranges, preserving unrelated authored bytes and validating the complete result. */
export const publishProfileText = (
  text: string,
  publications: ReadonlyArray<ProfilePublication>,
):
  | { readonly text: string; readonly error?: never }
  | { readonly error: string; readonly text?: never } => {
  try {
    const decode = Schema.decodeUnknownSync(SourceDeclarationSchema, { onExcessProperty: "error" });
    const before = decode(Yaml.parse(text));
    const document = parseDocument(text);
    if (
      document.errors.length > 0 ||
      isMap(document.contents) === false ||
      document.contents.flow === true
    )
      return { error: "Use a block mapping for tack.yaml before publishing a profile." };
    const version = document.get("version", true);
    if (isScalar(version) === false || version.range === undefined || version.range === null)
      return {
        error: "Use an explicit version: 1 or version: 2 value before publishing a profile.",
      };
    const newline = text.includes("\r\n") === true ? "\r\n" : "\n";
    const existing = document.get("profiles", true);
    const key = document.contents.items.find(
      (pair) => isScalar(pair.key) === true && pair.key.value === "profiles",
    )?.key;
    if (
      existing !== undefined &&
      (isSeq(existing) === false ||
        existing.range === undefined ||
        existing.range === null ||
        isScalar(key) === false ||
        key.range === undefined)
    )
      return { error: "Use an explicit profiles list before publishing a profile." };
    const sequence = isSeq(existing) === true ? existing.clone() : document.createNode([]);
    sequence.flow = false;
    sequence.items = publications.map(
      (publication) =>
        (isSeq(existing) === true ? existing.items : []).find(
          (item) =>
            isMap(item) === true &&
            item.get("name") === publication.name &&
            item.get("path") === publication.path,
        ) ?? document.createNode(publication),
    );
    const section = stringify({ profiles: sequence }).replaceAll("\n", newline);
    const profilesEdit: DeclarationTextEdit =
      isSeq(existing) === true &&
      existing.range !== undefined &&
      existing.range !== null &&
      isScalar(key) === true &&
      key.range !== undefined
        ? { start: key.range[0], end: existing.range[2], text: section }
        : {
            start: text.length,
            end: text.length,
            text: `${text.endsWith(newline) === true ? newline : newline + newline}${section}`,
          };
    const edited = applyDeclarationTextEdits(text, [
      { start: version.range[0], end: version.range[1], text: "2" },
      profilesEdit,
    ]);
    const after = decode(Yaml.parse(edited));
    if (deepStrictEqual(after, { ...before, version: 2, profiles: publications }) === false)
      return {
        error:
          "Publishing would change unrelated declaration values. Review tack.yaml before saving.",
      };
    return { text: edited };
  } catch {
    return {
      error:
        "Cannot safely edit this source declaration. Repair its YAML and check the source before saving.",
    };
  }
};
