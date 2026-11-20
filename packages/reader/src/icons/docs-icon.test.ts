import { House, Rocket } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocsIconSet, Icon } from "./docs-icon.tsx";

const render = (props: Parameters<typeof Icon>[0]) =>
  renderToStaticMarkup(
    createElement(
      DocsIconSet.Provider,
      { value: { house: House, rocket: Rocket } },
      createElement(Icon, props),
    ),
  );

describe("Icon", () => {
  it("draws a bundled docs icon at the text's size and color, hidden when decorative", () => {
    const markup = render({ name: "house" });
    expect(markup).toMatch(/^<svg [^>]*class="lucide lucide-house[^"]* tack-icon"/);
    expect(markup).toContain('width="1em"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("role=");
  });

  it("names a meaningful icon for assistive technology", () => {
    const markup = render({ name: "rocket", label: "Deployed" });
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Deployed"');
    expect(markup).not.toContain("aria-hidden");
  });

  it("marks an icon the reader did not bundle instead of drawing nothing", () => {
    const markup = render({ name: "database" });
    expect(markup).toBe(
      '<span class="tack-icon-missing" data-icon="database" title="Icon &quot;database&quot; is not available: see the issue list" aria-hidden="true"></span>',
    );
  });
});
