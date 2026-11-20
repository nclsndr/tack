import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFigures } from "../src/figures/check.ts";
import { corpusIconIssues, corpusIconNames } from "../src/icons/collect.ts";
import { loadProjectCorpus } from "../src/project-corpus.ts";
import { exampleInput, examplePort, exampleRoot } from "./example.ts";

describe("the Atlas example docs set", () => {
  it("serves every healthy page of both resources, with the archive shelf configured", async () => {
    const corpus = await loadProjectCorpus(exampleInput());

    expect(corpus.documents.map((document) => document.relativePath).toSorted()).toEqual([
      "about.md",
      "architecture/overview.mdx",
      "architecture/request-path.mdx",
      "archive/2025-06-10-first-sketch.md",
      "data/schema.mdx",
      "decisions/2026-11-02-queue-uploads.md",
      "guides/icons.mdx",
      "guides/onboarding.mdx",
      "on-call.md",
    ]);
    expect(
      corpus.resources.map((resource) => [
        resource.resource.name,
        resource.config?.navigation.archive,
      ]),
    ).toEqual([
      ["specs", [join(exampleRoot, "docs/archive")]],
      ["handbook", undefined],
    ]);
  });

  it("reports exactly its two deliberate issues: one skipped draft, one unavailable resource", async () => {
    const corpus = await loadProjectCorpus(exampleInput());

    expect(corpus.issues.map((issue) => [issue.code, issue.resource.name, issue.path])).toEqual([
      ["docs-resource-unavailable", "runbooks", undefined],
      ["document-load", "specs", join(exampleRoot, "docs/drafts/broken.mdx")],
    ]);
  });

  it("draws every figure component without a figure issue", async () => {
    // The broken draft is left out: the check refuses a document it cannot parse.
    const report = await checkFigures(
      ["docs/about.md", "docs/architecture", "docs/data", "docs/guides"].map((path) =>
        join(exampleRoot, path),
      ),
    );
    const components = report.documents.flatMap((document) =>
      document.figures.map((figure) => [figure.component, figure.status]),
    );

    expect(report.failing).toBe(0);
    expect(
      components.toSorted(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      ["ArchitectureMap", "ok"],
      ["Chart", "ok"],
      ["FileTree", "ok"],
      ["Schema", "ok"],
      ["System", "ok"],
      ["Walkthrough", "ok"],
    ]);
  });
});

describe("examplePort", () => {
  it("defaults to the example's own port and reads --port", () => {
    expect(examplePort([])).toBe(4317);
    expect(examplePort(["--port", "43180"])).toBe(43180);
    expect(examplePort(["--port=0"])).toBe(0);
  });

  it.each([["--port"], ["--port", "http"], ["--port", "70000"], ["--port", "4.5"]])(
    "refuses %j",
    (...argv) => {
      expect(() => examplePort(argv)).toThrow("--port takes a port number from 0 to 65535");
    },
  );
});

describe("the Atlas example icons", () => {
  it("bundles the icons its pages and its component name, and reports its one deliberate old name", async () => {
    const corpus = await loadProjectCorpus(exampleInput());

    expect(await corpusIconNames(corpus)).toEqual([
      "circle-check",
      "circle-x",
      "cloud",
      "database",
      "git-branch",
      "hourglass",
      "triangle-alert",
    ]);
    expect(corpusIconIssues(corpus.documents)).toEqual([
      {
        path: join(exampleRoot, "docs/guides/icons.mdx"),
        line: 29,
        name: "home",
        message: 'unknown icon "home": Lucide renamed it "house"',
        suggestions: ["house"],
      },
    ]);
  });
});
