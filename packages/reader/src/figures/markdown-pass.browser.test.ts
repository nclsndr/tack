// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FigureFrame } from "./frame.tsx";

// Rspress's Markdown pass renders with a client reconciler; this suite stands in for it.
vi.mock("../markdown-pass.ts", () => ({ markdownPass: () => true }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

it("prints the figure's readable text in a block of its own instead of its frame and drawing", async () => {
  await act(async () =>
    root.render(
      createElement(FigureFrame, {
        id: "deploy",
        kind: "system",
        title: "A deploy never skips the queue",
        issues: [],
        readable: "Deploy figure\n\nThe queue runs first.",
        state: {},
        controls: createElement("button", { type: "button" }, "Lens"),
        drawing: () => createElement("svg", null),
      }),
    ),
  );
  expect(container.innerHTML).toBe("<pre>Deploy figure\n\nThe queue runs first.</pre>");
});
