import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Chart, Walkthrough } from "./visuals.tsx";

describe("shared reader visuals", () => {
  it("exports every walkthrough step as readable content while showing one step", () => {
    const html = renderToStaticMarkup(
      createElement(Walkthrough, {
        id: "install",
        title: "Install a skill",
        steps: [
          { title: "Register", body: "Retain source content." },
          { title: "Apply", body: "Create relative adapter symlinks." },
        ],
      }),
    );
    expect(html).toContain("Retain source content.");
    expect(html).toContain("Create relative adapter symlinks.");
    expect(html).toContain('data-reader-readable="Install a skill');
    expect(html).toContain('data-reader-state="{&quot;step&quot;:1}"');
    expect(html).toContain('hidden=""');
    expect(html).toContain("Previous step");
    expect(html).toContain("Next step");
  });

  it("renders an authored React step with an explicit readable export", () => {
    const html = renderToStaticMarkup(
      createElement(Walkthrough, {
        id: "custom",
        steps: [
          {
            title: "Inspect",
            body: createElement("strong", null, "Visible detail"),
            readable: "Portable detail",
          },
        ],
      }),
    );
    expect(html).toContain("<strong>Visible detail</strong>");
    expect(html).toContain("Portable detail");
    const fallback = renderToStaticMarkup(
      createElement(Walkthrough, {
        id: "fallback",
        steps: [
          { title: "Generated", body: createElement("em", null, "References only") },
          { title: "Number", body: 42 },
        ],
      }),
    );
    expect(fallback).toContain("References only");
    expect(fallback).toContain("42");
  });

  it("handles empty walkthroughs without an invalid current step", () => {
    const html = renderToStaticMarkup(createElement(Walkthrough, { id: "empty", steps: [] }));
    expect(html).toContain("No steps have been authored.");
    expect(html).toContain("&quot;step&quot;:0");
  });

  it("renders the chart values from the same data used by readable copy", () => {
    const html = renderToStaticMarkup(
      createElement(Chart, {
        id: "cost",
        title: "Authoring cost",
        unit: "lines",
        data: [
          { label: "Setup", value: 120 },
          { label: "Second page", value: 18 },
        ],
        scenarios: [
          { id: "base", label: "Baseline", multiplier: 1 },
          { id: "twice", label: "Double", multiplier: 2 },
        ],
      }),
    );
    expect(html).toContain("Setup: 120 lines");
    expect(html).toContain("Second page: 18 lines");
    expect(html).toContain("Scenario");
    expect(html).toContain("Multiplier");
    expect(html).toContain("Scale");
    expect(html).toContain("Double");
    expect(html).not.toContain("NaN");
  });

  it("handles zero, negative, and empty chart values", () => {
    const html = renderToStaticMarkup(
      createElement(Chart, {
        id: "zero",
        data: [
          { label: "Zero", value: 0 },
          { label: "Negative", value: -4 },
        ],
      }),
    );
    expect(html).toContain("Negative: -4");
    expect(html).not.toContain("NaN");
    expect(renderToStaticMarkup(createElement(Chart, { id: "empty", data: [] }))).toContain(
      "No values have been authored.",
    );
    const invalid = renderToStaticMarkup(
      createElement(Chart, { id: "invalid", data: [{ label: "Bad", value: NaN }], scenarios: [] }),
    );
    expect(invalid).toContain("No values have been authored.");
    expect(invalid).toContain("Baseline");
  });
});
