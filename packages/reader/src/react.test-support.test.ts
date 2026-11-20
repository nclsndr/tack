// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { waitForReact } from "./react.test-support.ts";

afterEach(() => vi.unstubAllGlobals());

it("returns immediately when the assertion already passes", async () => {
  const assertion = vi.fn();
  await waitForReact(assertion);
  expect(assertion).toHaveBeenCalledOnce();
});

it("rethrows the assertion error when its deadline expires", async () => {
  const error = new Error("still waiting");
  await expect(
    waitForReact(
      () => {
        throw error;
      },
      { timeout: 0 },
    ),
  ).rejects.toBe(error);
});

it("flushes asynchronous React updates before retrying the DOM assertion", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  function Delayed(): string {
    const [text, setText] = useState("waiting");
    useEffect(() => {
      const timer = setTimeout(() => setText("ready"), 10);
      return () => clearTimeout(timer);
    }, []);
    return text;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Delayed)));
    expect(container.textContent).toBe("waiting");
    await waitForReact(() => expect(container.textContent).toBe("ready"));
  } finally {
    await act(async () => root.unmount());
  }
});
