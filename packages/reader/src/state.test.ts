import { act, createElement } from "react";
import { renderToMarkdownString } from "react-render-to-markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { numericState, readVisualState, updateVisualState, useVisualState } from "./state.ts";

/** Prints one visual's URL state, as a figure reads it while it renders. */
function StateProbe(props: { readonly id: string }) {
  const [state] = useVisualState(props.id);
  return createElement("p", null, `state: ${JSON.stringify(state)}`);
}

afterEach(() => vi.unstubAllGlobals());

describe("visual URL state without a window", () => {
  // Rspress writes Markdown twins with this client renderer in Node, where no `window` exists.
  it("reads every visual in its initial state", async () => {
    expect(typeof globalThis.window).toBe("undefined");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // act runs the render, then the passive effect in which React subscribes. It holds React's
    // work until its callback returns, so the callback starts the render and does not await it.
    const { markdown } = await act(async () => ({
      markdown: renderToMarkdownString(createElement(StateProbe, { id: "walk" })),
    }));
    expect(await markdown).toBe("state: {}\n\n");
  });
});

describe("visual URL state", () => {
  it("keeps each visual separate and preserves the page anchor and other state", () => {
    const href = "http://localhost/guide?type=spec&reader.flow.step=2#apply";
    const updated = updateVisualState(href, "chart", { multiplier: "1.5", selected: "small" });
    expect(updated).toBe(
      "/guide?type=spec&reader.flow.step=2&reader.chart.multiplier=1.5&reader.chart.selected=small#apply",
    );
    expect(readVisualState(new URL(updated, "http://localhost").search, "flow")).toEqual({
      step: "2",
    });
    expect(readVisualState(new URL(updated, "http://localhost").search, "chart")).toEqual({
      multiplier: "1.5",
      selected: "small",
    });
  });

  it("replaces a value, removes reset values, and encodes unusual identifiers", () => {
    const updated = updateVisualState(
      "http://localhost/?reader.flow.step=2&reader.flow.node=a",
      "flow",
      { step: "3", node: null },
    );
    expect(updated).toBe("/?reader.flow.step=3");
    const unusual = updateVisualState("http://localhost/", "diagram one", { selected: "a & b" });
    expect(readVisualState(new URL(unusual, "http://localhost").search, "diagram one")).toEqual({
      selected: "a & b",
    });
    expect(readVisualState("?reader.other.step=1", "flow")).toEqual({});
  });

  it("separates an identifier containing a dot from a shorter identifier", () => {
    const updated = updateVisualState("http://localhost/?reader.flow.step=2", "flow.detail", {
      selected: "a",
    });
    expect(readVisualState(new URL(updated, "http://localhost").search, "flow")).toEqual({
      step: "2",
    });
    expect(readVisualState(new URL(updated, "http://localhost").search, "flow.detail")).toEqual({
      selected: "a",
    });
  });

  it("bounds numeric parameters and rejects blank, infinite, and malformed input", () => {
    const options = { fallback: 1, min: 0, max: 3 };
    expect(numericState(undefined, options)).toBe(1);
    expect(numericState("", options)).toBe(1);
    expect(numericState(" ", options)).toBe(1);
    expect(numericState("Infinity", options)).toBe(1);
    expect(numericState("not-a-number", options)).toBe(1);
    expect(numericState("-3", options)).toBe(0);
    expect(numericState("20", options)).toBe(3);
    expect(numericState("1.75", options)).toBe(1.75);
    expect(numericState("1.75", { ...options, integer: true })).toBe(1);
  });
});
