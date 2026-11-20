import { PanelLeft, Search, Sun } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Glyph } from "./glyph.tsx";

const svg = (markup: string) => {
  const match = /^<svg ([^>]*)>/.exec(markup);
  if (match === null) throw new Error(`Not an svg: ${markup}`);
  return match[1] ?? "";
};

describe("Glyph", () => {
  it.each([Search, PanelLeft])("draws a Lucide icon, hidden from assistive technology", (icon) => {
    const attributes = svg(renderToStaticMarkup(createElement(Glyph, { icon })));

    expect(attributes).toContain('class="lucide');
    expect(attributes).toContain('width="16"');
    expect(attributes).toContain('stroke="currentColor"');
    expect(attributes).toContain('aria-hidden="true"');
    expect(attributes).toContain('focusable="false"');
  });

  it("keeps one physical stroke whatever the size", () => {
    const strokes = [16, 13].map((size) =>
      Number(
        /stroke-width="([^"]+)"/.exec(
          renderToStaticMarkup(createElement(Glyph, { icon: Sun, size })),
        )?.[1],
      ),
    );

    // Lucide scales the stroke to its 24-unit grid so it draws 1.4 px at any rendered size.
    expect((strokes[0] ?? 0) * (16 / 24)).toBeCloseTo(1.4, 5);
    expect((strokes[1] ?? 0) * (13 / 24)).toBeCloseTo(1.4, 5);
  });

  it("adds placement classes after its size", () => {
    expect(
      svg(renderToStaticMarkup(createElement(Glyph, { icon: Search, className: "absolute" }))),
    ).toMatch(/class="lucide[^"]* size-4 shrink-0 absolute"/);
  });
});
