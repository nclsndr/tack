// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { FigureFrame } from "./frame.tsx";
import { testRoot } from "../react.test-support.ts";

// Rspress's Markdown pass renders with a client reconciler; this suite stands in for it.
vi.mock("../markdown-pass.ts", () => ({ markdownPass: () => true }));

const ui = testRoot();

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

it("prints the figure's readable text in a block of its own instead of its frame and drawing", async () => {
  await ui.render(
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
  );
  expect(ui.container.innerHTML).toBe("<pre>Deploy figure\n\nThe queue runs first.</pre>");
});
