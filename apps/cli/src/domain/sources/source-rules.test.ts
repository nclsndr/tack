import { expect, it } from "vitest";
import { declarationWarnings, rulesBodyLimit, sourceDescriptionLimit } from "./source-rules.ts";
import type { SourceDeclaration } from "./source-schema.ts";

type Change = Pick<SourceDeclaration, "description" | "rules">;

const rules = (body: string) => ({ description: "Before any edit.", body });

it.each<[string, Change, ReadonlyArray<string>]>([
  ["no description and no rules", {}, []],
  ["a description at the limit", { description: "d".repeat(sourceDescriptionLimit) }, []],
  ["a body at the limit", { rules: rules("b".repeat(rulesBodyLimit)) }, []],
  [
    "a description over the limit",
    { description: "d".repeat(sourceDescriptionLimit + 1) },
    ["source-description-long"],
  ],
  // Four bytes each: the limit counts the UTF-8 bytes an agent reads, not the characters.
  ["a body over the limit in bytes", { rules: rules("🙂".repeat(513)) }, ["source-rules-long"]],
])("warns about %s", (_case, change, codes) => {
  expect(declarationWarnings(change).map(({ code }) => code)).toEqual(codes);
});

it("names the limit and what Tack does past it", () => {
  const [description, body] = declarationWarnings({
    description: "d".repeat(201),
    rules: rules("b".repeat(2049)),
  });
  expect(description?.message).toBe(
    "The description has 201 characters; keep it to one sentence of at most 200 characters, which names what the source holds.",
  );
  expect(body?.message).toBe(
    "The rules body has 2049 bytes, over the 2048 that the tack-sources skill inlines. The skill points agents to this tack.yaml instead: shorten the body to inline it.",
  );
});
