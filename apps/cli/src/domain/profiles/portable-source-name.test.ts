import { expect, it } from "vitest";
import type { Catalog } from "../sources/catalog-schema.ts";
import { portableSourceName } from "./portable-source-name.ts";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";

type Source = NonNullable<Catalog["sources"]>[number];
type Facts = Pick<Source, "label" | "labelOrigin" | "origin">;
const declared = { label: "tools", labelOrigin: "declared" } as const;
const source = (id: string, facts: Facts = declared): Source => ({
  registration: { id, canonicalPath: `/sources/${id}` },
  status: "healthy",
  ...facts,
});
const catalog = (sources: ReadonlyArray<Source>): Catalog => ({
  entries: [],
  quarantined: [],
  sources,
  unhealthySources: [],
});

it("uses a declared name that one healthy source carries", () => {
  expect(portableSourceName(catalog([source(first)]), first)).toBe("tools");
});

it("uses a built-in source's derived name", () => {
  expect(
    portableSourceName(
      catalog([source(first, { label: "tools", labelOrigin: "derived", origin: "builtin" })]),
      first,
    ),
  ).toBe("tools");
});

it.each([
  ["a name two healthy sources share", [source(first), source(second)]],
  ["a declared source without a name", [source(first, { labelOrigin: "declared" })]],
  ["a directory-derived name", [source(first, { label: "tools", labelOrigin: "derived" })]],
  ["an unknown source", [source(second, { label: "other", labelOrigin: "declared" })]],
])("has no portable name for %s", (_case, sources) => {
  expect(portableSourceName(catalog(sources), first)).toBeUndefined();
});
