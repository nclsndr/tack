import { expect, it } from "vitest";
import { bundleReferences } from "./bundle-references.ts";

it("reads JSX asset attributes as literal, expression-literal or computed references", () => {
  expect(
    bundleReferences(
      "view.tsx",
      [
        'export * from "./shared";',
        "export const local = 1;",
        'import type { Shape } from "./types";',
        'const a = <img src="./a.png" alt="a" />;',
        'const b = <img src={"./b.png"} />;',
        "const c = <img src={name} />;",
        'const d = require("./x", "extra");',
      ].join("\n"),
    ),
  ).toEqual([
    { kind: "module", value: "./shared" },
    { kind: "asset", value: "./a.png" },
    { kind: "asset", value: "./b.png" },
    { kind: "computed", value: "asset reference" },
    { kind: "computed", value: "module path" },
  ]);
});

it("resolves a Markdown link reference through its definition, and ignores one without", () => {
  expect(bundleReferences("guide.md", "See [the guide][missing].\n")).toEqual([]);
  expect(
    bundleReferences("guide.md", "See [the guide][guide].\n\n[guide]: ./guide-two.md\n"),
  ).toEqual([{ kind: "asset", value: "./guide-two.md" }]);
});

it("reads MDX expressions and JSX element attributes without running them", () => {
  expect(
    bundleReferences(
      "guide.mdx",
      [
        '{import("./dynamic.ts")}',
        "",
        "{ }",
        "",
        '<Figure src="./c.png" alt="c" {...props} />',
        "",
        '<Figure src={"./d.png"} data={require("./data.json")} />',
        "",
        "<Figure src={name} />",
        "",
      ].join("\n"),
    ),
  ).toEqual([
    { kind: "module", value: "./dynamic.ts" },
    { kind: "asset", value: "./c.png" },
    { kind: "asset", value: "./d.png" },
    { kind: "module", value: "./data.json" },
    { kind: "computed", value: "asset reference" },
  ]);
});
