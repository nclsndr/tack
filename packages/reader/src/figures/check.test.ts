import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { checkFigures, figureReportLines, staticFigures } from "./check.ts";
import { NotStatic, renderedNode } from "./static-props.ts";
import {
  ArchitectureMap,
  Badge,
  Band,
  Box,
  Chart,
  Drawing,
  Figure,
  FileTree,
  Label,
  Link,
  Note,
  Walkthrough,
} from "../visuals.tsx";
import type { AuthoredElement } from "./authored-model.ts";

const fixtures = resolve(import.meta.dirname, "../../fixtures/figures");
const page = join(fixtures, "tack-cli-architecture.mdx");
const broken = join(fixtures, "broken-figures.mdx");

async function folder(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tack-figure-check-")));
  await Promise.all(
    Object.entries(files).map(async ([path, contents]) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), contents);
    }),
  );
  return root;
}

describe("the figure check", () => {
  it("prints ok for the Tack CLI architecture map, links imported from its data file", async () => {
    const report = await checkFigures([page]);
    expect(figureReportLines(report, fixtures)).toEqual([
      "tack-cli-architecture.mdx",
      "  cli-architecture-map: ok",
    ]);
    expect(report).toMatchObject({ figures: 1, failing: 0, unchecked: 0 });
  });

  it("lists each issue of a broken figure and says why a computed one is not checked", async () => {
    const report = await checkFigures([broken]);
    expect(figureReportLines(report, fixtures)).toEqual([
      "broken-figures.mdx",
      "  broken-map: 3 issues",
      '    input: title "CLI architecture" reads as a noun phrase; write the claim the figure proves as a sentence',
      '    input: duplicate id "app": node "app again" is left out',
      '    input: link api -> cache names an unknown id "cache"',
      "  sound-steps: ok",
      "  computed-map: not checked: tiers: it is computed at runtime (a function call)",
      "  broken-tree: 1 issue",
      "    input: line 3: odd indentation (3 spaces); use two per level",
      "  broken-drawing: 2 issues (1 raw shape not checked)",
      '    layout: boxes "export" and "gate" overlap',
      '    layout: link left -> far crosses box "mid", which is not one of its ends',
      "  broken-system: 3 issues",
      '    input: node "cache" has unknown kind "memcache"; drawn as a service',
      "    input: link api -> db has no label; say what moves or what is done",
      '    input: node "cache" is in no link; link it or leave it out',
      "  broken-schema: 1 issue",
      "    input: public.parcels.dock_id references undeclared table public.docks",
    ]);
    expect(report).toMatchObject({ figures: 7, failing: 5, unchecked: 1 });
  });

  it("prints the same issue lines as the page lists under each figure", async () => {
    const kit = {
      band: Band,
      badge: Badge,
      box: Box,
      label: Label,
      link: Link,
      note: Note,
    } as const;
    /** An authored figure's statically read drawing, as the elements an author writes. */
    const drawn = (drawing: unknown) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Statically read props are untyped by design; the components read them leniently.
      const { height, elements } = drawing as {
        height: number;
        elements: readonly AuthoredElement[];
      };
      return createElement(
        Drawing,
        { height },
        ...elements.map((element, index) =>
          element.element === "raw"
            ? createElement("path", { key: index })
            : createElement(
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Statically read props are untyped by design; the components read them leniently.
                kit[element.element] as never,
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Statically read props are untyped by design; the components read them leniently.
                { key: index, ...element.props } as never,
              ),
        ),
      );
    };
    const components = { ArchitectureMap, Chart, FileTree, Walkthrough } as const;
    const figures = await staticFigures(broken);
    const report = await checkFigures([broken]);
    const checked = report.documents[0]?.figures ?? [];
    figures.forEach((figure, index) => {
      // System and Schema list their layout issues once laid out: their browser tests compare those.
      if (
        figure.props instanceof NotStatic ||
        figure.component === "System" ||
        figure.component === "Schema"
      )
        return;
      if (figure.component === "Figure") {
        const { drawing, ...frame } = figure.props;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Statically read props are untyped by design; the components read them leniently.
        const html = renderToStaticMarkup(createElement(Figure, frame as never, drawn(drawing)));
        const listed =
          /data-figure-issues="([^"]*)"/
            .exec(html)?.[1]
            ?.replaceAll("&quot;", '"')
            .replaceAll("&gt;", ">") ?? "[]";
        const result = checked[index];
        expect(JSON.parse(listed)).toEqual(result?.status === "issues" ? result.issues : []);
        return;
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The check only returns catalog component names.
      const component = components[figure.component as keyof typeof components];
      // A rendered node in data (JSX) stands in for content; the page would render it, so does this.
      const props: unknown = JSON.parse(
        JSON.stringify(figure.props, (_key, value: unknown) =>
          value === renderedNode ? "" : value,
        ),
      );
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Statically read props are untyped by design; the component reads them leniently.
      const html = renderToStaticMarkup(createElement(component as never, props as never));
      const listed =
        /data-figure-issues="([^"]*)"/
          .exec(html)?.[1]
          ?.replaceAll("&quot;", '"')
          .replaceAll("&gt;", ">") ?? "[]";
      const result = checked[index];
      expect(JSON.parse(listed)).toEqual(result?.status === "issues" ? result.issues : []);
    });
  });

  it("walks a docs folder, reading trees in Markdown and skipping hidden and underscore folders", async () => {
    const root = await folder({
      "guide.md":
        '# Plain\n\n<ArchitectureMap />\n\n```tree id="disk" title="One folder holds one file"\na/\n  b\n```\n',
      "_reference/old.mdx": '<Chart id="x" />\n',
      ".drafts/new.mdx": '<Chart id="x" />\n',
      "nested/chart.mdx":
        'import data from "./data.json";\n\n<Chart id="costs" title="Setup costs most of the first week" data={data.values} />\n',
      "nested/data.json": JSON.stringify({
        values: [
          { label: "Setup", value: 4 },
          { label: "", value: 1 },
        ],
      }),
    });
    const report = await checkFigures([root]);
    expect(figureReportLines(report, root)).toEqual([
      "guide.md",
      "  disk: ok",
      "nested/chart.mdx",
      "  costs: 1 issue",
      "    input: value 2 has no label",
    ]);
  });

  it("names a figure without a readable id by its component and line", async () => {
    const root = await folder({
      "page.mdx": "# Page\n\n<Chart title={`Costs ${1 + 1}`} data={[]} />\n",
    });
    const report = await checkFigures([join(root, "page.mdx")]);
    expect(figureReportLines(report, root)).toEqual([
      "page.mdx",
      "  Chart at line 3: not checked: title: it is computed at runtime (an expression)",
    ]);
  });

  it("prints ok for the build and runtime explainer: a tree and two authored figures", async () => {
    const report = await checkFigures([
      join(fixtures, "relay-build-and-run.mdx"),
      join(fixtures, "tree-in-markdown.md"),
    ]);
    expect(figureReportLines(report, fixtures)).toEqual([
      "relay-build-and-run.mdx",
      "  release-pipeline: ok",
      "  release-on-disk: ok",
      "  who-runs-what: ok",
      "tree-in-markdown.md",
      "  docs-on-disk: ok",
    ]);
  });

  it("reads a wrapped tree, and an authored figure's drawing from a paragraph or with no drawing", async () => {
    const root = await folder({
      "page.mdx": [
        '<FileTree id="t" title="A tree with one unknown lens entry" lenses={[{ label: "L", note: "n", present: ["nope"] }]}>',
        "",
        "```tree",
        "a",
        "```",
        "",
        "</FileTree>",
        "",
        '<Figure id="f" title="A figure with an inline drawing">',
        '  <Drawing height={100}><Box id="a" x={16} y={16} label="a" /><g /></Drawing>',
        "</Figure>",
        "",
        '<Figure id="g" title="A figure that forgot its drawing" />',
        "",
        '<Figure id="h" title="A figure whose box is computed">',
        "  <Drawing height={100}>",
        '    <Box id={`a${1}`} x={1 + 1} y={0} label="a" />',
        "  </Drawing>",
        "</Figure>",
      ].join("\n"),
    });
    expect(figureReportLines(await checkFigures([root]), root)).toEqual([
      "page.mdx",
      "  t: 1 issue",
      '    input: lens "L" names an unknown entry "nope"',
      "  f: ok (1 raw shape not checked)",
      "  g: 1 issue",
      "    input: the figure has no <Drawing height={...}>; give the drawing and its height",
      "  h: not checked: x: it is computed at runtime (an expression)",
    ]);
  });

  it("finds a drawing among a figure's prose and names a figure with a computed id by its line", async () => {
    const root = await folder({
      "page.mdx": [
        '<Figure id="f" title="A figure that explains its drawing in prose">',
        "",
        "## About this drawing",
        "",
        'The drawing: <Drawing height={100}><Box id="a" x={16} y={16} label="a" /></Drawing>',
        "",
        "</Figure>",
        "",
        "<Chart id={7} data={[]} />",
      ].join("\n"),
    });
    expect(figureReportLines(await checkFigures([root]), root)).toEqual([
      "page.mdx",
      "  f: ok",
      "  Chart at line 9: 2 issues",
      "    input: id is required: a short lowercase slug",
      "    input: title is missing; write the claim the figure proves as a sentence",
    ]);
  });

  it("asks for a title on every walkthrough step", async () => {
    const root = await folder({
      "page.mdx":
        '<Walkthrough id="steps" title="Two steps install the reader" steps={[{ title: "Install" }, { body: "Run it." }]} />\n',
    });
    expect(figureReportLines(await checkFigures([root]), root)).toEqual([
      "page.mdx",
      "  steps: 1 issue",
      "    input: step 2 has no title",
    ]);
  });

  it("prints the full document path when it lies outside the folder the report is relative to", async () => {
    const root = await folder({ "page.mdx": "<Chart id={7} title={make()} />\n" });
    expect(figureReportLines(await checkFigures([root]), join(root, "elsewhere"))).toEqual([
      join(root, "page.mdx"),
      "  Chart at line 1: not checked: title: it is computed at runtime (a function call)",
    ]);
  });

  it("lists each unknown icon by line with the closest names, after the figures", async () => {
    const root = await folder({
      "page.mdx": [
        "# Icons",
        "",
        '<Icon name="database" /> and <Icon name="home" />',
        "",
        '```tree id="t" title="A docs folder holds pages"',
        "docs/",
        "  page.md",
        "```",
        "",
        "<Icon name={name} />",
      ].join("\n"),
      "plain.md": '# Plain\n\n<Icon name="home" />\n',
    });
    const report = await checkFigures([root]);
    expect(report).toMatchObject({ figures: 1, failing: 0, icons: 3, unknownIcons: 2 });
    expect(figureReportLines(report, root)).toEqual([
      "page.mdx",
      "  t: ok",
      '  icon line 3: unknown icon "home": Lucide renamed it "house"',
      '  icon line 10: an Icon needs a literal name, such as name="database", so the reader can bundle it',
    ]);
  });

  it("lists each misused author component by line, after the icons", async () => {
    const root = await folder({
      "page.mdx":
        '# Parts\n\n<Callout kind="danger" icon="home">x</Callout>\n\n<Term>bare</Term>\n',
    });
    const report = await checkFigures([root]);
    expect(report).toMatchObject({ components: 2, failingComponents: 2, unknownIcons: 1 });
    expect(figureReportLines(report, root)).toEqual([
      "page.mdx",
      '  icon line 3: unknown icon "home": Lucide renamed it "house"',
      '  Callout line 3: Callout kind "danger" is not one of note, tip, warning, decision',
      '  Term line 5: a Term needs its definition, such as title="A folder Tack reads"',
    ]);
  });

  it("leaves out a document whose figures and icons are all fine, but counts its icons", async () => {
    const root = await folder({ "page.mdx": '# Fine\n\n<Icon name="rocket" />\n' });
    const report = await checkFigures([root]);
    expect(report).toMatchObject({
      documents: [],
      figures: 0,
      icons: 1,
      unknownIcons: 0,
      components: 0,
      failingComponents: 0,
    });
  });

  it("names a path that does not exist", async () => {
    await expect(checkFigures(["no/such/page.mdx"])).rejects.toMatchObject({
      code: "ENOENT",
      message: "no/such/page.mdx: no document or folder at this path",
    });
  });
});

describe("reading props without running the page", () => {
  const props = async (files: Readonly<Record<string, string>>) => {
    const root = await folder(files);
    return (await staticFigures(join(root, "page.mdx"))).map((figure) =>
      figure.props instanceof NotStatic ? `not static: ${figure.props.message}` : figure.props,
    );
  };

  it("follows names into local modules: named, default, namespace and re-exports", async () => {
    expect(
      await props({
        "page.mdx": [
          'import { links } from "./data/links";',
          'import tiers from "./data/tiers.ts";',
          'import * as all from "./data/index.ts";',
          'export const title = `A map whose ${"links"} come from a file`;',
          "",
          '<ArchitectureMap id="m" title={title} tiers={tiers} links={links} extra={all.count} flag {...{ summary: "S" }} minus={-2} />',
        ].join("\n"),
        "data/links.ts":
          'type L = { from: string };\nexport const links: L[] = [{ from: "a", to: "b" }] as const;\n',
        "data/tiers.ts":
          "const tiers = [{ id: 't', nodes: [...[1, 2]] }];\nexport default tiers;\n",
        "data/index.ts":
          'export { links } from "./links.ts";\nconst count = 2;\nexport { count };\n',
      }),
    ).toEqual([
      {
        id: "m",
        title: "A map whose links come from a file",
        tiers: [{ id: "t", nodes: [1, 2] }],
        links: [{ from: "a", to: "b" }],
        extra: 2,
        flag: true,
        summary: "S",
        minus: -2,
      },
    ]);
  });

  it("reports what only the running page can know", async () => {
    expect(
      await props({
        "page.mdx": [
          'import { make } from "some-package";',
          'import { missing } from "./data.ts";',
          "export const loop = loop;",
          "",
          "<Chart data={make} />",
          "<Chart data={make()} />",
          "<Chart data={missing} />",
          "<Chart data={loop} />",
          "<Chart data={nowhere} />",
          "<Chart data={/x/} />",
          "<Chart data={!true} />",
          "<Chart data={{ get x() { return 1; } }} />",
          "<Chart data={[...'ab'.length]} />",
          "<Chart {...[1]} />",
          "<Chart data={(1).x} />",
          "<Chart data={{ ...1 }} />",
          "<Chart data={[...{}]} />",
          "<Chart data={broken} />",
          "<Chart data={() => 1} />",
        ].join("\n"),
        "data.ts": "export const other = 1;\nexport default function f() {}\n",
      }).then((list) => list.map((value) => (typeof value === "string" ? value : "static"))),
    ).toEqual([
      'not static: data: "make" comes from "some-package", which is not a local file',
      "not static: data: it is computed at runtime (a function call)",
      expect.stringMatching(/^not static: data: .*data\.ts exports no "missing"$/),
      'not static: data: "loop" refers to itself',
      'not static: data: "nowhere" is not defined in the document',
      "not static: data: a regular expression",
      "not static: data: the operator !",
      "not static: data: an object method or accessor",
      "not static: data: a property of something that is not data",
      "not static: a spread of something that is not an object",
      "not static: data: a property of something that is not data",
      "not static: data: a spread of something that is not an object",
      "not static: data: a spread of something that is not a list",
      'not static: data: "broken" is not defined in the document',
      "not static: data: it is computed at runtime (a function)",
    ]);
  });

  it("reads literal forms, string export names and declarations that hold no data", async () => {
    expect(
      await props({
        "page.mdx": [
          'import { "label text" as label, plain, later, kept } from "./data.ts";',
          'import { "renamed text" as renamed } from "./relay.ts";',
          "",
          '<Chart id="c" data={[1, , +2]} keyed={{ ["k"]: plain["v"] }} none={undefined} label={label} renamed={renamed} />',
          "<Chart data={later} />",
          "<Chart data={kept} />",
        ].join("\n"),
        "data.ts": [
          "const text = 'L';",
          "export const plain = { v: 3 };",
          "export let later;",
          "export const { kept } = { kept: 1 };",
          "export function helper() {}",
          "function hidden() {}",
          'export { text as "label text", hidden };',
        ].join("\n"),
        "relay.ts": [
          'export { "label text" as "renamed text" } from "./data.ts";',
          'export { outside } from "some-package";',
        ].join("\n"),
      }),
    ).toEqual([
      {
        id: "c",
        data: [1, undefined, 2],
        keyed: { k: 3 },
        none: undefined,
        label: "L",
        renamed: "L",
      },
      expect.stringMatching(/^not static: data: .*data\.ts exports no "later"$/),
      expect.stringMatching(/^not static: data: .*data\.ts exports no "kept"$/),
    ]);
  });

  it("names an unreadable namespace module and an unusual expression", async () => {
    expect(
      await props({
        "page.mdx": [
          'import * as bad from "./bad.ts";',
          "",
          "<Chart data={bad} />",
          "<Chart data={this} />",
        ].join("\n"),
        "bad.ts": "export const x = [;\n",
      }),
    ).toEqual([
      expect.stringMatching(/^not static: data: .*bad\.ts cannot be read as data: /),
      "not static: data: it is computed at runtime (a ThisExpression)",
    ]);
  });

  it("reports a data file that cannot be parsed", async () => {
    const [value] = await props({
      "page.mdx": 'import { x } from "./bad.ts";\n\n<Chart data={x} />\n',
      "bad.ts": "export const x = [;\n",
    });
    expect(value).toMatch(/^not static: data: .*bad\.ts cannot be read as data: /);
  });
});
