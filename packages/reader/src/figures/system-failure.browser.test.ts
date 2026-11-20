// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Schema } from "./schema.tsx";
import { domainModel } from "./schema-fixtures.ts";
import { System } from "./system.tsx";
import { capturePath } from "./system-fixtures.ts";

const engine = vi.hoisted(() => ({ load: vi.fn<() => Promise<never>>() }));
vi.mock("./layout-engine.ts", () => ({
  loadLayoutEngine: engine.load,
  layoutEngineRequested: () => true,
}));

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
  vi.unstubAllGlobals();
});

it("lists a layout engine that fails as a layout issue and keeps the rest of the figure", async () => {
  engine.load.mockRejectedValue(new Error("no engine"));
  await act(async () => root.render(createElement(System, capturePath)));
  await vi.waitFor(() => {
    expect(container.querySelector(".tack-figure-pending")?.textContent).toBe(
      "The figure could not be laid out.",
    );
  });
  const figure = container.querySelector<HTMLElement>("figure");
  expect(JSON.parse(figure?.dataset["figureIssues"] ?? "[]")).toEqual([
    "layout: the layout engine failed: no engine",
  ]);
  expect(figure?.dataset["readerReadable"]).toContain("Redis stream -> worker-core: XREADGROUP");
});

it("says it is laying out until the engine answers, and names a failure that is not an Error", async () => {
  let fail: (reason: unknown) => void = () => undefined;
  engine.load.mockReturnValue(
    new Promise<never>((_resolve, reject) => {
      fail = reject;
    }),
  );
  const props = { ...capturePath, id: "pending" };
  await act(async () => root.render(createElement(System, props)));
  expect(container.querySelector(".tack-figure-pending")?.textContent).toBe(
    "Laying out the figure…",
  );
  await act(async () => fail("busy"));
  await vi.waitFor(() => {
    expect(container.querySelector("figure")?.dataset["figureIssues"]).toContain(
      "the layout engine failed: busy",
    );
  });
});

it("drops a layout that arrives after the figure is gone", async () => {
  let fail: (reason: unknown) => void = () => undefined;
  engine.load.mockReturnValue(
    new Promise<never>((_resolve, reject) => {
      fail = reject;
    }),
  );
  await act(async () => root.render(createElement(System, { ...capturePath, id: "gone" })));
  await act(async () => root.unmount());
  await act(async () => fail(new Error("late")));
  expect(container.innerHTML).toBe("");
  root = createRoot(container);
});

it("lists a layout engine that fails a Schema as a layout issue and keeps its text", async () => {
  engine.load.mockRejectedValue(new Error("no engine"));
  await act(async () => root.render(createElement(Schema, domainModel)));
  await vi.waitFor(() => {
    expect(container.querySelector(".tack-figure-pending")?.textContent).toBe(
      "The figure could not be laid out.",
    );
  });
  const figure = container.querySelector<HTMLElement>("figure");
  expect(JSON.parse(figure?.dataset["figureIssues"] ?? "[]")).toEqual([
    "layout: the layout engine failed: no engine",
  ]);
  expect(figure?.dataset["readerReadable"]).toContain("Source -> Resource: declares");
});
