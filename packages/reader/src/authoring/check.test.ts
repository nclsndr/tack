import { describe, expect, it } from "vitest";
import { checkDocumentComponents } from "./check.ts";

const page = [
  "# Page",
  "",
  '<Callout kind="warning" title="Breaking">No aliases.</Callout>',
  "",
  '<Callout kind="danger">Bad kind.</Callout>',
  "",
  "<Tabs>",
  '  <Tab label="macOS">brew</Tab>',
  '  <Tab label="macOS">again</Tab>',
  "  <Tab>no label</Tab>",
  "</Tabs>",
  "",
  '<Tabs><Tab label="Only">one</Tab></Tabs>',
  "",
  '<Tab label="Loose">outside</Tab>',
  "",
  'A <Term title="A folder Tack reads">source</Term> and a <Term>bare</Term> one.',
].join("\n");

describe("checkDocumentComponents", () => {
  it("counts the author components and finds each misuse by file and line", () => {
    const report = checkDocumentComponents(page, "/docs/page.mdx");
    expect(report.components).toBe(11);
    expect(report.findings).toEqual([
      {
        path: "/docs/page.mdx",
        line: 5,
        component: "Callout",
        message: 'Callout kind "danger" is not one of note, tip, warning, decision',
      },
      {
        path: "/docs/page.mdx",
        line: 9,
        component: "Tab",
        message: 'Tab label "macOS" is used twice in the same Tabs',
      },
      {
        path: "/docs/page.mdx",
        line: 10,
        component: "Tab",
        message: 'a Tab needs a label, such as label="macOS"',
      },
      {
        path: "/docs/page.mdx",
        line: 13,
        component: "Tabs",
        message: "Tabs needs at least two Tab children; one alternative is just content",
      },
      {
        path: "/docs/page.mdx",
        line: 15,
        component: "Tab",
        message: "a Tab only works inside Tabs",
      },
      {
        path: "/docs/page.mdx",
        line: 17,
        component: "Term",
        message: 'a Term needs its definition, such as title="A folder Tack reads"',
      },
    ]);
  });

  it("counts only the Tab children of Tabs, past a code block between them", () => {
    const source = [
      "<Tabs>",
      '  <Tab label="npm">npm</Tab>',
      "",
      "  ```sh",
      "  npm install --global @tackup/cli",
      "  ```",
      "",
      '  <Tab label="Bun">bun</Tab>',
      "</Tabs>",
    ].join("\n");
    expect(checkDocumentComponents(source, "/docs/tabs.mdx")).toEqual({
      components: 3,
      findings: [],
    });
  });

  it("checks no Markdown, which renders no components", () => {
    expect(checkDocumentComponents('<Callout kind="danger" />', "/docs/a.md")).toEqual({
      components: 0,
      findings: [],
    });
  });
});
