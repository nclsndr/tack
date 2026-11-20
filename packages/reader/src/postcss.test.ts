import { describe, expect, it } from "vitest";
import { isolateReaderStylesheet } from "./postcss.ts";

const stylesheet = "/reader/src/reader.css";
const tailwind = { postcssPlugin: "tailwind" };
const worktreePlugin = { postcssPlugin: "worktree" };

describe("reader stylesheet PostCSS isolation", () => {
  it("processes the reader stylesheet with the reader plugins only", () => {
    const options = isolateReaderStylesheet(
      () => ({ plugins: [worktreePlugin], map: { inline: false } }),
      stylesheet,
      [tailwind],
    );
    expect(options({ resourcePath: stylesheet })).toEqual({ plugins: [tailwind], config: false });
  });
  it("tells postcss-loader not to search for a configuration of its own", () => {
    expect(isolateReaderStylesheet(undefined, stylesheet, [tailwind]).config).toBe(false);
  });
  it("keeps the worktree configuration for every other stylesheet", () => {
    const context = { resourcePath: "/worktree/docs/style.css" };
    const fromFunction = isolateReaderStylesheet(
      (received: typeof context) => ({ plugins: [worktreePlugin], from: received.resourcePath }),
      stylesheet,
      [tailwind],
    );
    expect(fromFunction(context)).toEqual({
      plugins: [worktreePlugin],
      from: context.resourcePath,
    });
    const fromObject = isolateReaderStylesheet({ plugins: [worktreePlugin] }, stylesheet, [
      tailwind,
    ]);
    expect(fromObject(context)).toEqual({ plugins: [worktreePlugin] });
    expect(isolateReaderStylesheet(undefined, stylesheet, [tailwind])(context)).toEqual({});
  });
});
