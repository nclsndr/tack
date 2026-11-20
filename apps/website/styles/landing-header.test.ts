import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = ["./tokens.css", "./landing.css"]
  .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
  .join("\n");

/** The first value the stylesheet gives each custom property. */
const properties = [...stylesheet.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)].reduce(
  (found, [, name = "", value = ""]) =>
    found.has(name) === true ? found : new Map([...found, [name, value.trim()]]),
  new Map<string, string>(),
);

/** The declarations of the first rule whose selector is exactly `selector`. */
const declarations = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(stylesheet)?.[1];
  if (body === undefined) throw new Error(`No rule for ${selector}`);
  return new Map(
    body
      .split(";")
      .map((line) => line.replace(/\/\*[\s\S]*?\*\//g, "").trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as const;
      }),
  );
};

/**
 * The length, in pixels, of a CSS value made of `px` lengths, plain numbers, `var()` of other
 * custom properties, `calc()`, brackets and the four operators.
 */
const pixels = (value: string): number => {
  const tokens = value.match(/var\(--[\w-]+\)|calc\(|-?\d*\.?\d+(?:px)?|[()+\-*/]/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++] ?? "";
  const primary = (): number => {
    const token = next();
    if (token === "(" || token === "calc(") {
      const inner = sum();
      next();
      return inner;
    }
    const name = /^var\((--[\w-]+)\)$/.exec(token)?.[1];
    if (name !== undefined) {
      const resolved = properties.get(name);
      if (resolved === undefined) throw new Error(`${name} is not defined`);
      return pixels(resolved);
    }
    return Number.parseFloat(token);
  };
  const product = (): number => {
    let result = primary();
    while (peek() === "*" || peek() === "/") {
      result = next() === "*" ? result * primary() : result / primary();
    }
    return result;
  };
  const sum = (): number => {
    let result = product();
    while (peek() === "+" || peek() === "-") {
      result = next() === "+" ? result + product() : result - product();
    }
    return result;
  };
  return sum();
};

const token = (name: string) => pixels(`var(${name})`);

describe("landing header card", () => {
  const header = token("--landing-header-height");
  const button = token("--landing-header-button-height");
  const inset = token("--landing-card-inset");
  const cardTop = token("--landing-card-top");
  const cardHeight = token("--landing-card-height");
  const buttonTop = (header - button) / 2;

  it("keeps one gap between the header button and the card on the top, right and bottom", () => {
    expect(inset).toBeGreaterThan(0);
    expect(buttonTop - cardTop).toBe(inset);
    expect(cardTop + cardHeight - (buttonTop + button)).toBe(inset);
    expect(token("--landing-card-bleed")).toBe(inset);
  });

  it("rounds the card concentric with the header button", () => {
    expect(token("--landing-card-radius")).toBe(token("--tack-radius-button") + inset);
  });

  it("draws the card and the header button from those tokens", () => {
    const card = declarations(".landing-header-bar::before");
    expect(card.get("inset")).toBe("var(--landing-card-top) calc(-1 * var(--landing-card-bleed))");
    expect(card.get("border-radius")).toBe("var(--landing-card-radius)");
    const headerButton = declarations(".landing-header-bar > .landing-button");
    expect(headerButton.get("height")).toBe("var(--landing-header-button-height)");
    expect(headerButton.get("border-radius")).toBe("var(--tack-radius-button)");
  });
});
