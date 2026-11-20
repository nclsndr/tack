import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  initialSidebar,
  keyedSidebarWidth,
  loadSidebarLayout,
  saveSidebarLayout,
  sidebarWidths,
} from "./sidebar.ts";

const key = "tack-reader:sidebar";

function storage(value: string | null) {
  const writes: [string, string][] = [];
  return {
    writes,
    getItem: () => value,
    setItem: (name: string, item: string) => {
      writes.push([name, item]);
    },
  };
}

describe("sidebar width", () => {
  it("keeps widths inside the readable range in whole pixels", () => {
    expect(clampSidebarWidth(10)).toBe(sidebarWidths.min);
    expect(clampSidebarWidth(9000)).toBe(sidebarWidths.max);
    expect(clampSidebarWidth(300.6)).toBe(301);
    expect(clampSidebarWidth(Number.NaN)).toBe(sidebarWidths.initial);
  });

  it("steps with arrow keys and jumps to the bounds with Home and End", () => {
    expect(keyedSidebarWidth(300, "ArrowRight")).toBe(300 + sidebarWidths.step);
    expect(keyedSidebarWidth(300, "ArrowLeft")).toBe(300 - sidebarWidths.step);
    expect(keyedSidebarWidth(sidebarWidths.max, "ArrowRight")).toBe(sidebarWidths.max);
    expect(keyedSidebarWidth(sidebarWidths.min, "ArrowLeft")).toBe(sidebarWidths.min);
    expect(keyedSidebarWidth(300, "Home")).toBe(sidebarWidths.min);
    expect(keyedSidebarWidth(300, "End")).toBe(sidebarWidths.max);
    expect(keyedSidebarWidth(300, "Enter")).toBeUndefined();
  });
});

describe("stored sidebar layout", () => {
  it("restores a saved layout and constrains its width", () => {
    expect(loadSidebarLayout(() => storage('{"width":360,"hidden":true}'))).toEqual({
      width: 360,
      hidden: true,
    });
    expect(loadSidebarLayout(() => storage('{"width":9000,"hidden":false}'))).toEqual({
      width: sidebarWidths.max,
      hidden: false,
    });
  });

  it("falls back to the initial layout when nothing readable is stored", () => {
    expect(loadSidebarLayout(() => storage(null))).toEqual(initialSidebar);
    expect(loadSidebarLayout(() => storage("{broken"))).toEqual(initialSidebar);
    expect(loadSidebarLayout(() => storage('{"width":"wide"}'))).toEqual(initialSidebar);
    expect(
      loadSidebarLayout(() => {
        throw new Error("Storage is unavailable");
      }),
    ).toEqual(initialSidebar);
  });

  it("saves the layout and tolerates unavailable storage", () => {
    const target = storage(null);
    saveSidebarLayout(() => target, { width: 300, hidden: true });
    expect(target.writes).toEqual([[key, '{"width":300,"hidden":true}']]);
    expect(() =>
      saveSidebarLayout(
        () => ({
          setItem: () => {
            throw new Error("Quota exceeded");
          },
        }),
        initialSidebar,
      ),
    ).not.toThrow();
  });
});
